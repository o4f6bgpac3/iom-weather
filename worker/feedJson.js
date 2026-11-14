/**
 * Isle of Man Met Office 5-day forecast, via the JSON listing API that
 * weather.gov.im's own front end uses (the old gov.im RSS feed is gone).
 *
 * Endpoint returns: {"forecasts": [{forecastDate, icon, maxTemp, minTemp,
 * windDirection, windSpeed, windComments, visibility, averageRainfall,
 * rainfallComments, issuedOn, forecastContent, forecasterName, warnings,
 * sunTimes}, ...]}. All timestamps are Europe/London local time with no offset.
 */

import {parseRainfallRange, parseVisibilityCode} from "./utils.js";

// The site sits behind a WAF that blocks non-browser clients.
export const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://weather.gov.im/",
};

const TIME_ZONE = "Europe/London";

/**
 * Parses "DD-MM-YYYY HH:mm:ss" or "YYYY-MM-DD HH:mm:ss" into its parts.
 * @returns {{y:number,mo:number,d:number,h:number,mi:number,s:number}|null}
 */
function parseLocalTimestamp(str) {
    if (typeof str !== "string") return null;
    const s = str.trim();
    let m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return {y: +m[3], mo: +m[2], d: +m[1], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0)};
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return {y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0)};
    return null;
}

/** Offset (ms) of Europe/London from UTC at the given instant. */
function londonOffsetMs(utcMs) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - utcMs;
}

/** Converts a London-local timestamp string to a UTC ISO string. */
export function londonToUtcIso(str) {
    const t = parseLocalTimestamp(str);
    if (!t) throw new Error("Invalid timestamp: " + str);
    const naive = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
    return new Date(naive - londonOffsetMs(naive)).toISOString();
}

/** Extracts the calendar date (YYYY-MM-DD) from a forecastDate string. */
export function toIsoDate(str) {
    const t = parseLocalTimestamp(str);
    if (!t) throw new Error("Invalid forecast date: " + str);
    return `${t.y}-${String(t.mo).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
}

const ENTITIES = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°"};

/** Strips tags and decodes entities, returning plain text. */
export function htmlToText(html) {
    if (!html) return "";
    return String(html)
        .replace(/<[^>]*>/g, " ")
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, e) => {
            if (e[0] === "#") {
                const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
            }
            return ENTITIES[e.toLowerCase()] ?? whole;
        })
        // Re-strip anything that decoded into markup; stored text is rendered as HTML by the app.
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Splits forecastContent into the forecast paragraph and the "Comments:" text.
 * Shape: <div><h3>Forecast</h3><p>…</p></div><p><strong>Comments:</strong> …</p>
 */
export function splitForecastContent(html) {
    const content = String(html || "");
    const commentsMatch = content.match(/<p[^>]*>\s*<strong>\s*Comments:?\s*<\/strong>([\s\S]*?)<\/p>/i);
    const comments = commentsMatch ? htmlToText(commentsMatch[1]) : "";
    const withoutComments = commentsMatch ? content.replace(commentsMatch[0], "") : content;
    const description = htmlToText(withoutComments.replace(/<h3[^>]*>[\s\S]*?<\/h3>/gi, ""));
    return {description, comments: comments && !/^nil\.?$/i.test(comments) ? comments : null};
}

/** "south-west" -> "SW", "north-north-east" -> "NNE"; anything else kept as-is. */
export function abbreviateWindDirection(dir) {
    if (!dir) return null;
    const parts = String(dir).trim().toLowerCase().split(/[\s-]+/);
    const letters = {north: "N", south: "S", east: "E", west: "W"};
    if (parts.every((p) => letters[p])) return parts.map((p) => letters[p]).join("");
    return String(dir).trim();
}

function toInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

/** Maps one API forecast object onto a forecast_items row. */
export function mapForecast(f) {
    const published_at = londonToUtcIso(f.issuedOn);
    const forecast_date = toIsoDate(f.forecastDate);
    const {description, comments: contentComments} = splitForecastContent(f.forecastContent);
    const rainfallComments = htmlToText(f.rainfallComments);
    const comments = [contentComments, rainfallComments].filter(Boolean).join(" ") || null;

    const rainfall = f.averageRainfall ? `${String(f.averageRainfall).trim()}mm` : null;
    const {min: rainfall_min, max: rainfall_max} = parseRainfallRange(rainfall);
    const visibility = htmlToText(f.visibility);

    return {
        published_at,
        forecast_date,
        description,
        min_temp: toInt(f.minTemp),
        max_temp: toInt(f.maxTemp),
        wind_speed: toInt(f.windSpeed),
        wind_direction: abbreviateWindDirection(f.windDirection),
        wind_details: htmlToText(f.windComments),
        visibility,
        visibility_code: parseVisibilityCode(visibility),
        comments,
        rainfall,
        rainfall_min,
        rainfall_max,
        guid: `wgim-${published_at}-${forecast_date}`,
    };
}

/** Fetches and maps the forecast listing. Throws on block pages or bad shape. */
export async function fetchForecasts(url) {
    console.log("Fetching forecast JSON from:", url);
    const response = await fetch(url, {headers: BROWSER_HEADERS});
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("application/json")) {
        throw new Error(`Forecast fetch failed: HTTP ${response.status} (${contentType || "no content-type"})`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.forecasts)) {
        throw new Error("Invalid forecast JSON structure");
    }

    const forecasts = [];
    for (const f of data.forecasts) {
        try {
            forecasts.push(mapForecast(f));
        } catch (e) {
            console.error("Error mapping forecast:", e, f?.forecastDate);
        }
    }
    console.log("Total forecasts parsed:", forecasts.length);
    return forecasts;
}
