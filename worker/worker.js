/**
 * IOM Weather Worker
 *
 * Cloudflare Worker that fetches weather forecasts from the Isle of Man
 * government RSS feed, parses them, and stores them in a D1 database.
 *
 * Main responsibilities:
 * - Scheduled fetching of weather data (cron trigger)
 * - API endpoints for retrieving forecasts
 * - Natural language query handling (via /ask endpoint)
 */

import {XMLParser} from "fast-xml-parser";
import {handleAskRequest} from "./ask.js";
import {CONFIG} from "./config.js";
import {parseRainfallRange, parseVisibilityCode} from "./utils.js";

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
                html_body: `<p>${message}</p>`,
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

/**
 * Converts strings like "Today", "Tomorrow", or "Thursday, 13 February 2025"
 * into an ISO date (YYYY-MM-DD) using the published_at as a reference.
 */
function parseForecastDate(dateStr, published_at) {
    console.log("Parsing forecast date:", dateStr, "with published_at:", published_at);
    const lower = dateStr.toLowerCase();
    let result;
    if (lower === "today") {
        result = new Date(published_at);
    } else if (lower === "tomorrow") {
        const d = new Date(published_at);
        d.setDate(d.getDate() + 1);
        result = d;
    } else if (dateStr.includes(",")) {
        // Example: "Thursday, 13 February 2025"
        const parts = dateStr.split(",");
        if (parts.length > 1) {
            result = new Date(parts[1].trim());
        } else {
            result = new Date(dateStr);
        }
    } else {
        result = new Date(dateStr);
    }
    if (isNaN(result.getTime())) {
        throw new Error("Invalid forecast date: " + dateStr);
    }
    const isoDate = result.toISOString().split("T")[0];
    console.log("Parsed date result:", isoDate);
    return isoDate;
}

/**
 * A helper to decode a few common HTML entities.
 */
function decodeHtmlEntities(text) {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/**
 * Parses a forecast section from the RSS feed description HTML.
 *
 * The Isle of Man government RSS feed contains HTML descriptions with
 * weather data structured using h2, h3, and p tags.
 *
 * ## Expected HTML Structure
 *
 * ```html
 * <h2>Today</h2>
 * <p>General weather description for the day</p>
 * <h3>Temperature</h3>
 * <p>Min. air temperature 5°C and max. air temperature 10°C</p>
 * <h3>Wind Speed</h3>
 * <p>15</p>
 * <h3>Wind Direction</h3>
 * <p>SW</p>
 * <h3>Visibility</h3>
 * <p>Good</p>
 * <h3>Rainfall (mm)</h3>
 * <p>0-5</p>
 * <h3>Comments</h3>
 * <p>Optional additional notes</p>
 * ```
 *
 * The h2 tag contains the date (can be "Today", "Tomorrow", or full date).
 * Each h3/p pair contains a data field and its value.
 *
 * @param {string} section - HTML section starting with <h2>
 * @param {string} published_at - ISO timestamp when the forecast was published
 * @returns {Object} - Parsed forecast object with normalized fields
 * @throws {Error} - If the HTML structure is invalid
 */
function parseForecastSection(section, published_at) {
    // Extract the forecast date from the <h2> header.
    const h2Close = section.indexOf("</h2>");
    if (h2Close === -1) {
        throw new Error("No closing </h2> tag found in section: " + section);
    }
    // Remove the opening <h2> tag and trim.
    const headerHtml = section.substring(0, h2Close).replace(/<h2>/i, "").trim();
    const forecast_date = parseForecastDate(headerHtml, published_at);

    // Look for a general description (the first <p> following the h2).
    let description = "";
    const afterH2 = section.substring(h2Close + 5).trim();
    const descMatch = afterH2.match(/^<p>(.*?)<\/p>/);
    if (descMatch) {
        description = descMatch[1].trim();
    }

    // Build a dictionary from any h3/p pairs.
    // This regex will match pairs like: <h3>Some Header</h3> followed by <p>Content</p>
    const regex = /<h3>(.*?)<\/h3>\s*<p>(.*?)<\/p>/g;
    let match;
    const data = {};
    while ((match = regex.exec(section)) !== null) {
        const key = match[1].toLowerCase();
        data[key] = match[2].trim();
    }

    // Build the forecast object.
    const forecast = {
        published_at,
        forecast_date,
        description,
        min_temp: null,
        max_temp: null,
        wind_speed: null,
        wind_direction: null,
        wind_details: "",
        visibility: "",
        visibility_code: null, // Denormalized: 'good', 'moderate', 'poor'
        comments: null,
        rainfall: null,
        rainfall_min: null, // Denormalized: numeric min value
        rainfall_max: null, // Denormalized: numeric max value
    };

    if (data["temperature"]) {
        // Expect something like "Min. air temperature 2°C and max. air temperature 6°C"
        const tempMatches = data["temperature"].match(/(-?\d+).*?(-?\d+)/);
        if (tempMatches) {
            forecast.min_temp = parseInt(tempMatches[1]);
            forecast.max_temp = parseInt(tempMatches[2]);
        }
    }
    if (data["wind speed"]) {
        forecast.wind_speed = parseInt(data["wind speed"]);
    }
    if (data["wind direction"]) {
        forecast.wind_direction = data["wind direction"];
    }
    // If there’s any additional wind information (e.g. if an h3 exists that mentions "wind" but isn’t exactly "wind speed" or "wind direction")
    for (const key in data) {
        if (key.includes("wind") && key !== "wind speed" && key !== "wind direction") {
            forecast.wind_details = data[key];
        }
    }
    if (data["visibility"]) {
        forecast.visibility = data["visibility"];
        forecast.visibility_code = parseVisibilityCode(data["visibility"]);
    }
    if (data["comments"]) {
        forecast.comments = data["comments"];
    }

    if (data["rainfall (mm)"] || data["rainfall (mm):"]) {
        const rainfallKey = data["rainfall (mm)"] ? "rainfall (mm)" : "rainfall (mm):";
        forecast.rainfall = data[rainfallKey];

        // Extract denormalized numeric values using utility function
        const { min, max } = parseRainfallRange(forecast.rainfall);
        forecast.rainfall_min = min;
        forecast.rainfall_max = max;
    }

    return forecast;
}

/**
 * Parses the RSS feed at the given URL using fast-xml-parser.
 * The description field is first HTML-decoded and then split into sections
 * based on <h2> tags.
 */
async function parseFeed(url) {
    console.log("Fetching RSS feed from:", url);
    const response = await fetch(url);
    const text = await response.text();
    console.log("RSS feed fetched, content length:", text.length);

    // Parse the XML with fast-xml-parser.
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
    });
    const feed = parser.parse(text);

    // Navigate the feed structure.
    let items = [];
    if (feed.rss && feed.rss.channel && feed.rss.channel.item) {
        items = feed.rss.channel.item;
        if (!Array.isArray(items)) {
            items = [items];
        }
    } else {
        throw new Error("Invalid RSS feed structure");
    }

    const forecasts = [];
    for (const item of items) {
        const published_at = item.pubDate
            ? new Date(item.pubDate).toISOString()
            : new Date().toISOString();
        // Updated guid extraction:
        const guid = item.guid
            ? (typeof item.guid === "string"
                ? item.guid.trim()
                : item.guid["#text"]
                    ? item.guid["#text"].trim()
                    : "")
            : "";
        let description = item.description || "";
        description = decodeHtmlEntities(description);

        // Split the description into sections.
        // Each section begins with an <h2> tag.
        const sections = description.split(/<h2>/).slice(1).map((sec) => "<h2>" + sec);
        for (const section of sections) {
            try {
                const forecast = parseForecastSection(section, published_at);
                // Create a unique guid for each forecast item.
                forecast.guid = `${guid}-${forecast.forecast_date}`;
                forecasts.push(forecast);
            } catch (e) {
                console.error("Error parsing forecast section:", e);
            }
        }
    }
    console.log("Total forecasts parsed:", forecasts.length);
    return forecasts;
}

// Insert new forecasts into the D1 database.
async function fetchAndStoreWeather(env) {
    console.log("Starting fetchAndStoreWeather");
    try {
        const feedUrl = CONFIG.feed.url;
        const items = await parseFeed(feedUrl);

        if (items.length === 0) {
            console.log("No items found in RSS feed");
            await sendNotification("No items found in RSS feed", env);
            return [];
        }

        const latestPublishedDate = await getLatestPublishedDate(env);
        const newPubDate = items[0].published_at;
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
            insert into forecast_items (published_at, forecast_date, min_temp, max_temp,
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
        await sendNotification(`Failed to fetch/store weather: ${error.message}`, env);
        throw error;
    }
}

// Retrieve future forecasts from the database.
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
    return results || [];
}

// Retrieve forecasts for a specific date.
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
    return results || [];
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
                const {result, status} = await handleAskRequest(request, env);
                return Response.json(result, {
                    status,
                    headers: corsHeaders(origin),
                });
            }

            // Handle forecast endpoint
            if (await shouldFetchNewData(env)) {
                console.log("Fetching new weather data");
                await fetchAndStoreWeather(env);
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
        console.log("Starting scheduled task");
        try {
            await fetchAndStoreWeather(env);
            console.log("Scheduled task completed successfully");
        } catch (error) {
            console.error("Scheduled task failed:", error);
        }
    },
};
