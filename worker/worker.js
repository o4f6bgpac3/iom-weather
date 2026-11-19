/**
 * IOM Weather Worker
 *
 * Cloudflare Worker that fetches weather forecasts from the Isle of Man
 * Met Office (weather.gov.im JSON API) and stores them in a D1 database.
 *
 * Main responsibilities:
 * - Scheduled fetching of weather data (cron trigger)
 * - API endpoints for retrieving forecasts
 * - Natural language query handling (via /ask endpoint)
 */

import { handleAskRequest, handleAskStreamRequest } from "./ask.js";
import {CONFIG} from "./config.js";
import { fetchForecasts } from "./feedJson.js";
import { getSunData } from "./sun.js";
import { getTidesForDate, refreshTideData } from "./tides.js";

// CORS helper.
function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin || CONFIG.cors.defaultOrigin,
        "Access-Control-Allow-Methods": CONFIG.cors.allowedMethods,
        "Access-Control-Allow-Headers": CONFIG.cors.allowedHeaders,
        "Access-Control-Max-Age": CONFIG.cors.maxAge,
    };
}

// Send an email notification.
async function sendNotification(message, env) {
    console.log("Sending notification:", message);
    try {
        const response = await fetch("https://api.smtp2go.com/v3/email/send", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                api_key: env.SMTP2GO_API_KEY,
                to: [env.NOTIFICATION_EMAIL_TO],
                sender: env.NOTIFICATION_EMAIL_FROM,
                subject: "IOM Weather Alert",
                text_body: message,
                html_body: `<p>${message.replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"})[c])}</p>`,
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("SMTP2Go error:", error);
        } else {
            console.log("Notification sent successfully");
        }
    } catch (error) {
        console.error("Failed to send notification:", error);
    }
}

// Retrieve the most-recent published date from the database.
async function getLatestPublishedDate(env) {
    console.log("Fetching latest published date from database");
    const result = await env.DB.prepare(
        "select max(published_at) as latest from forecast_items"
    ).first();
    console.log("Latest published date in database:", result?.latest || "No existing data");
    return result?.latest || "1970-01-01T00:00:00.000Z";
}

// Insert new forecasts into the D1 database.
async function fetchAndStoreWeather(env) {
    console.log("Starting fetchAndStoreWeather");
    try {
        const feedUrl = CONFIG.feed.url;
        const items = await fetchForecasts(feedUrl);

        if (items.length === 0) {
            throw new Error("No items found in forecast feed");
        }

        const latestPublishedDate = await getLatestPublishedDate(env);
        const newPubDate = items.reduce((max, i) => (i.published_at > max ? i.published_at : max), "");
        console.log("Comparing dates:", {
            latestInDb: latestPublishedDate,
            newFromFeed: newPubDate,
        });

        if (newPubDate <= latestPublishedDate) {
            console.log("No new data to process");
            return [];
        }

        console.log("New data found, preparing to insert");
        const stmt = env.DB.prepare(`
            insert or ignore into forecast_items (published_at, forecast_date, min_temp, max_temp,
                                        wind_speed, wind_direction, description,
                                        wind_details, visibility, visibility_code, comments,
                                        guid, rainfall, rainfall_min, rainfall_max)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const batch = items.map((item) =>
            stmt.bind(
                item.published_at,
                item.forecast_date,
                item.min_temp,
                item.max_temp,
                item.wind_speed,
                item.wind_direction,
                item.description,
                item.wind_details,
                item.visibility,
                item.visibility_code,
                item.comments,
                item.guid,
                item.rainfall,
                item.rainfall_min,
                item.rainfall_max
            )
        );

        console.log(`Inserting ${batch.length} new forecasts`);
        await env.DB.batch(batch);
        console.log("Database insert completed successfully");
        return items;
    } catch (error) {
        console.error("Error in fetchAndStoreWeather:", error);
        throw error;
    }
}

// Retrieve future forecasts from the database, enriched with sun/tide data.
async function getFutureForecasts(env) {
    console.log("Getting future forecasts from database");
    const query = `
        select *
        from forecast_items
        where forecast_date >= date('now')
        order by forecast_date asc, published_at desc
    `;
    const {results} = await env.DB.prepare(query).all();
    console.log(`Retrieved ${results?.length || 0} future forecasts from database`);

    let rows = results || [];
    if (rows.length === 0) {
        // Nothing current: fall back to the most recent days we hold, so the
        // site still shows something while the upstream feed is down.
        const fallback = await env.DB.prepare(`
            select *
            from forecast_items
            where forecast_date in (
                select distinct forecast_date from forecast_items
                order by forecast_date desc limit ?
            )
            order by forecast_date asc, published_at desc
        `).bind(CONFIG.feed.expectedForecastDays).all();
        rows = fallback.results || [];
        console.log(`No future forecasts; falling back to ${rows.length} recent rows`);
    }

    return Promise.all(rows.map(forecast => enrichForecastWithSunAndTides(forecast, env)));
}

// Hours since the newest forecast was published (Infinity if none).
async function hoursSinceLastPublish(env) {
    const row = await env.DB.prepare("select max(published_at) as latest from forecast_items").first();
    if (!row?.latest) return Infinity;
    return (Date.now() - new Date(row.latest).getTime()) / 3600000;
}

// Record one fetch attempt. Never throws: logging must not break fetching.
async function logFetch(env, trigger, ok, items, error) {
    try {
        await env.DB.prepare(
            "insert into fetch_log (attempted_at, trigger, ok, items, error) values (?, ?, ?, ?, ?)"
        ).bind(new Date().toISOString(), trigger, ok ? 1 : 0, items ?? null, error ?? null).run();
    } catch (e) {
        console.error("Failed to write fetch_log:", e);
    }
}

// True if a page-load fetch failed in the last 10 min (don't hammer upstream).
async function recentRequestFailure(env) {
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const row = await env.DB.prepare(
        "select 1 from fetch_log where trigger = 'request' and ok = 0 and attempted_at > ? limit 1"
    ).bind(since).first().catch(() => null);
    return Boolean(row);
}

// Fetch + store, logging the outcome. Returns the error (or null).
async function attemptFetch(env, trigger) {
    try {
        const items = await fetchAndStoreWeather(env);
        await logFetch(env, trigger, true, items.length, null);
        return null;
    } catch (error) {
        await logFetch(env, trigger, false, null, String(error?.message || error).slice(0, 500));
        return error;
    }
}

/**
 * Decide what this 30-minute cron tick should do.
 * Returns {kind: "regular"} | {kind: "retry", attempt, isLast} | {kind: "idle"}.
 */
async function planTick(env, now) {
    if (CONFIG.feed.regularHoursUtc.includes(now.getUTCHours()) && now.getUTCMinutes() < 30) {
        return {kind: "regular"};
    }
    const regular = await env.DB.prepare(
        "select attempted_at, ok from fetch_log where trigger = 'cron' order by attempted_at desc limit 1"
    ).first();
    if (!regular || regular.ok) return {kind: "idle"};

    const {results: retries} = await env.DB.prepare(
        "select ok from fetch_log where trigger = 'retry' and attempted_at > ? order by attempted_at"
    ).bind(regular.attempted_at).all();
    if (retries.some((r) => r.ok)) return {kind: "idle"};

    const offsets = CONFIG.feed.retryOffsetsMinutes;
    const done = retries.length;
    if (done >= offsets.length) return {kind: "idle"};
    // 5 min slack so cron jitter doesn't push a retry to the next tick.
    const dueAt = new Date(regular.attempted_at).getTime() + (offsets[done] - 5) * 60000;
    if (now.getTime() < dueAt) return {kind: "idle"};
    return {kind: "retry", attempt: done + 1, isLast: done + 1 === offsets.length};
}

// Retrieve forecasts for a specific date, enriched with sun/tide data.
async function getDateForecasts(env, date) {
    console.log(`Getting forecasts for date: ${date}`);
    const query = `
        select *
        from forecast_items
        where forecast_date = ?
        order by published_at desc
    `;
    const {results} = await env.DB.prepare(query).bind(date).all();
    console.log(`Retrieved ${results?.length || 0} forecasts for ${date}`);

    if (!results || results.length === 0) {
        return [];
    }

    // Enrich each forecast with sun and tide data
    const enriched = await Promise.all(
        results.map(forecast => enrichForecastWithSunAndTides(forecast, env))
    );

    return enriched;
}

// Determine whether new data should be fetched.
async function shouldFetchNewData(env) {
    const result = await env.DB.prepare(`
        select published_at, forecast_date
        from forecast_items
        order by published_at desc
        limit 1
    `).first();

    if (!result) return true;

    const lastPublished = new Date(result.published_at);
    const now = new Date();
    const hoursSinceLastUpdate = (now - lastPublished) / (1000 * 60 * 60);

    if (hoursSinceLastUpdate > CONFIG.feed.refreshThresholdHours) {
        console.log(`Last update was more than ${CONFIG.feed.refreshThresholdHours} hours ago`);
        return true;
    }

    // Check if forecasts exist for the expected number of days.
    const futureDates = await env.DB.prepare(`
        select count(distinct forecast_date) as count
        from forecast_items
        where forecast_date >= date('now')
    `).first();

    if (futureDates.count < CONFIG.feed.expectedForecastDays) {
        console.log("Missing forecasts for some future dates");
        return true;
    }

    console.log("Database is up to date");
    return false;
}

/**
 * Enrich forecast data with sun and tide information
 */
async function enrichForecastWithSunAndTides(forecast, env) {
  const dateStr = forecast.forecast_date;

  // Get sun data (calculated)
  const sun = getSunData(dateStr);

  // Get tide data (from database)
  const tides = await getTidesForDate(env.DB, dateStr);

  return {
    ...forecast,
    sun,
    tides: tides.high.length > 0 || tides.low.length > 0 ? tides : null,
  };
}

export default {
    async fetch(request, env, ctx) {
        console.log("Received request:", request.method, request.url);
        const origin = request.headers.get("Origin");

        if (request.method === "OPTIONS") {
            console.log("Handling OPTIONS request");
            return new Response(null, {
                headers: corsHeaders(origin),
            });
        }

        const url = new URL(request.url);

        try {
            // Handle /ask endpoint for natural language questions
            if (url.pathname === "/ask" && request.method === "POST") {
                // Check if client wants streaming response
                const acceptHeader = request.headers.get("Accept") || "";
                if (acceptHeader.includes("text/event-stream")) {
                    return handleAskStreamRequest(request, env);
                }

                // Non-streaming JSON response
                const { result, status } = await handleAskRequest(request, env);
                return Response.json(result, {
                    status,
                    headers: corsHeaders(origin),
                });
            }

            // Fetch health: recent attempts plus data age. Read-only, no secrets.
            if (url.pathname === "/status" && request.method === "GET") {
                const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 50, 1), 500);
                const {results: attempts} = await env.DB.prepare(
                    "select attempted_at, trigger, ok, items, error from fetch_log order by attempted_at desc limit ?"
                ).bind(limit).all();
                const ageHours = await hoursSinceLastPublish(env);
                return Response.json({
                    newest_forecast_age_hours: Number.isFinite(ageHours) ? +ageHours.toFixed(2) : null,
                    stale: !(ageHours <= CONFIG.feed.staleAlertHours),
                    attempts,
                }, {headers: {...corsHeaders(origin), "Cache-Control": "no-store"}});
            }

            // Handle forecast endpoint
            if (await shouldFetchNewData(env) && !(await recentRequestFailure(env))) {
                console.log("Fetching new weather data");
                // Serve what we already hold on failure; the cron job alerts.
                const error = await attemptFetch(env, "request");
                if (error) console.error("Live refresh failed, serving stored data:", error);
            }
            const date = url.searchParams.get("date");

            const results = date
                ? await getDateForecasts(env, date)
                : await getFutureForecasts(env);

            return Response.json(results, {
                headers: corsHeaders(origin),
            });
        } catch (error) {
            console.error("API endpoint failed:", error);
            return Response.json(
                {error: "Internal server error", message: error.message},
                {status: 500, headers: corsHeaders(origin)}
            );
        }
    },

    async scheduled(event, env, ctx) {
        const now = new Date(event.scheduledTime || Date.now());
        const plan = await planTick(env, now);
        if (plan.kind === "idle") return;
        console.log("Scheduled tick:", JSON.stringify(plan));

        const trigger = plan.kind === "regular" ? "cron" : "retry";
        const fetchError = await attemptFetch(env, trigger);
        const ageHours = await hoursSinceLastPublish(env).catch(() => Infinity);
        const ageText = Number.isFinite(ageHours) ? `${ageHours.toFixed(1)} hours` : "missing";

        // Alert once retries are exhausted, or when data is stale at a regular run.
        if (fetchError && plan.kind === "retry" && plan.isLast) {
            await sendNotification(
                `Forecast fetch failed after ${CONFIG.feed.retryOffsetsMinutes.length} retries: ${fetchError.message}. Newest stored forecast is ${ageText} old.`,
                env
            );
        } else if (plan.kind === "regular" && ageHours > CONFIG.feed.staleAlertHours) {
            await sendNotification(`No new forecast: newest stored forecast is ${ageText} old.`, env);
        }

        if (plan.kind === "regular") {
            try {
                await refreshTideData(env.DB);
                await env.DB.prepare("delete from fetch_log where attempted_at < ?")
                    .bind(new Date(now.getTime() - CONFIG.feed.fetchLogRetentionDays * 86400000).toISOString())
                    .run();
            } catch (error) {
                console.error("Scheduled housekeeping failed:", error);
            }
        }
    },
};
