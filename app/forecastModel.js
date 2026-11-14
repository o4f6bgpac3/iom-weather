/**
 * Forecast model
 *
 * Turns raw API forecasts into the "day" objects the tideline view and the 3D
 * scene draw from: a weather summary readable at a glance, sun times in
 * minutes, and a continuous tide curve interpolated between high/low water.
 */

import { parseForecastDate, formatRainfall } from "./utils.js";

const BEARINGS = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
    E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
    W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/** Keywords that mark each weather category in the forecaster's description. */
const WEATHER_KEYWORDS = {
    sunny: ["sun", "bright", "fine", "clear", "fair"],
    cloudy: ["cloud", "overcast", "gloomy", "dull", "grey", "gray", "variable"],
    rainy: ["rain", "shower", "drizzle", "wet", "downpour", "outbreaks"],
    snowy: ["snow", "wintry", "sleet", "hail", "blizzard"],
};

/** Weight for a keyword that follows "some" (e.g. "some rain"). */
const PARTIAL_WEIGHT = 0.5;

/** Tide heights are drawn against this ceiling (metres). */
export const TIDE_MAX = 8;

/** Half a tidal cycle, used to extend the curve past the first/last known point. */
const HALF_TIDE_MINUTES = 372;

/** Used when the API has no sun times for a day. */
const DEFAULT_SUNRISE = 7 * 60;
const DEFAULT_SUNSET = 17 * 60;

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

/** "07:45" -> 465. Returns null for anything that isn't a clock time. */
export function toMinutes(time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
    if (!m) return null;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    return mins >= 0 && mins < 1440 ? mins : null;
}

export function formatClock(minutes) {
    const m = Math.max(0, Math.floor(minutes));
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** ISO date (YYYY-MM-DD) a forecast is for. */
export function forecastIsoDate(forecast) {
    return parseForecastDate(forecast.forecast_date, forecast.published_at).toISOString().split("T")[0];
}

/** Compass direction ("SW", "south west") -> bearing in degrees, or null. */
export function windBearing(direction) {
    if (!direction) return null;
    return BEARINGS[String(direction).toUpperCase().replace(/\s+/g, "")] ?? null;
}

/** Scores each weather category by keyword matches in the description. */
export function scoreDescription(description) {
    const scores = { sunny: 0, cloudy: 0, rainy: 0, snowy: 0 };
    let partial = false;
    for (const word of String(description ?? "").toLowerCase().split(/[\s,.;]+/)) {
        if (word === "some") {
            partial = true;
            continue;
        }
        for (const category of Object.keys(WEATHER_KEYWORDS)) {
            if (WEATHER_KEYWORDS[category].some((keyword) => word.includes(keyword))) {
                scores[category] += partial ? PARTIAL_WEIGHT : 1;
                partial = false;
            }
        }
    }
    return scores;
}

/**
 * Summarises a day's weather for a glance.
 *
 * @returns {{label: string, icon: string, clouds: number, tone: string,
 *            sun: number, rain: number, snowfall: boolean}}
 *   clouds 1-4, tone white|light|grey|dark, sun 0 none / 1 peeking / 2 out,
 *   rain 0 none / 1 light / 2 moderate / 3 heavy.
 */
export function summariseWeather(description, rainfallMax) {
    const s = scoreDescription(description);
    const mm = Number.isFinite(rainfallMax) ? rainfallMax : 0;

    let rain = 0;
    if (mm >= 10) rain = 3;
    else if (s.rainy > 0) rain = mm >= 2 || s.rainy >= 1 ? 2 : 1;
    else if (mm >= 2) rain = 1;

    let sun = 0;
    if (s.sunny > 0 && rain < 3) sun = s.sunny >= Math.max(s.cloudy, s.rainy) ? 2 : 1;
    if (sun === 2 && rain === 2) rain = 1;

    const snowfall = s.snowy > 0 && s.snowy >= s.rainy;
    const showery = /shower/i.test(description ?? "");

    let clouds = 2;
    if (rain === 3) clouds = 4;
    else if (rain === 2) clouds = 3;
    else if (sun === 2) clouds = s.cloudy > 0 || rain > 0 ? 2 : 1;
    else if (s.cloudy > 0 || rain > 0) clouds = sun ? 2 : 3;

    let tone = "light";
    if (rain === 3) tone = "dark";
    else if (rain === 2 || (clouds === 3 && !sun)) tone = "grey";
    else if (sun === 2 && rain === 0) tone = "white";

    let label;
    let icon;
    if (snowfall) {
        label = "Snow";
        icon = "snow";
    } else if (rain === 3) {
        label = "Heavy rain";
        icon = "rain";
    } else if (rain === 2) {
        label = showery ? "Showers" : "Rain";
        icon = sun ? "showers" : "rain";
    } else if (sun === 2) {
        label = rain ? "Bright, odd shower" : s.cloudy > 0 ? "Sunny spells" : "Sunny";
        icon = rain ? "showers" : s.cloudy > 0 ? "partly" : "sunny";
    } else if (sun === 1) {
        label = rain ? "Sunny intervals, showers" : "Sunny intervals";
        icon = rain ? "showers" : "partly";
    } else if (rain === 1) {
        label = showery ? "A few showers" : "Light rain";
        icon = "rain";
    } else {
        label = "Cloudy";
        icon = "cloudy";
    }

    return { label, icon, clouds, tone, sun, rain, snowfall };
}

function tidePoints(list) {
    return (Array.isArray(list) ? list : [])
        .map((p) => ({ min: toMinutes(p?.time), height: Number(p?.height), time: p?.time }))
        .filter((p) => p.min !== null && Number.isFinite(p.height));
}

function numberOrNull(value) {
    return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

/**
 * Builds the day objects for a list of forecasts (one per date), sorted by date.
 */
export function buildDays(forecasts) {
    const days = forecasts.map((f) => {
        const date = forecastIsoDate(f);
        const rainMax = numberOrNull(f.rainfall_max) ?? numberOrNull(String(f.rainfall ?? "").match(/[\d.]+(?=\D*$)/)?.[0]);
        const comments = String(f.comments ?? "").trim();
        const minTemp = numberOrNull(f.min_temp);
        const weather = summariseWeather(f.description, rainMax);
        const hasSun = toMinutes(f.sun?.sunrise) !== null && toMinutes(f.sun?.sunset) !== null;
        return {
            date,
            minTemp,
            maxTemp: numberOrNull(f.max_temp),
            windSpeed: numberOrNull(f.wind_speed),
            windDirection: f.wind_direction || null,
            windBearing: windBearing(f.wind_direction),
            description: f.description || "",
            windDetails: f.wind_details || "",
            visibility: f.visibility || "",
            warning: comments && !/^nil\.?$/i.test(comments) ? comments : "",
            rainText: f.rainfall ? formatRainfall(String(f.rainfall).replace(/mm/gi, "")).replace(/mm/g, " mm") : "",
            rainMax,
            hasSun,
            sunrise: hasSun ? toMinutes(f.sun.sunrise) : DEFAULT_SUNRISE,
            sunset: hasSun ? toMinutes(f.sun.sunset) : DEFAULT_SUNSET,
            high: tidePoints(f.tides?.high),
            low: tidePoints(f.tides?.low),
            weather,
            snowcap: (minTemp !== null && minTemp <= 0) || scoreDescription(f.description).snowy > 0,
        };
    });
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
    const first = days.length ? Date.parse(`${days[0].date}T00:00:00Z`) : 0;
    days.forEach((d) => {
        // Whole days since the first day, so the tide curve stays correct across gaps.
        d.offset = Math.round((Date.parse(`${d.date}T00:00:00Z`) - first) / 86400000);
    });
    return days;
}

/**
 * Returns tideAt(t): tide height in metres at timeline minute t, where
 * t = dayIndex * 1440 + minuteOfDay. Cosine-interpolates between the known
 * high/low points. Returns null when no day has tide data.
 */
export function makeTide(days) {
    const points = [];
    days.forEach((d) => {
        d.high.forEach((p) => points.push({ t: d.offset * 1440 + p.min, h: p.height, high: true }));
        d.low.forEach((p) => points.push({ t: d.offset * 1440 + p.min, h: p.height, high: false }));
    });
    if (points.length < 2) return () => null;
    points.sort((a, b) => a.t - b.t);

    const mean = (high) => {
        const hs = points.filter((p) => p.high === high).map((p) => p.h);
        return hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
    };
    const meanHigh = mean(true) ?? points[0].h;
    const meanLow = mean(false) ?? points[0].h;
    const first = points[0];
    const last = points[points.length - 1];
    const curve = [
        { t: first.t - HALF_TIDE_MINUTES, h: first.high ? meanLow : meanHigh },
        ...points,
        { t: last.t + HALF_TIDE_MINUTES, h: last.high ? meanLow : meanHigh },
    ];

    return (t) => {
        const index = Math.min(days.length - 1, Math.max(0, Math.floor(t / 1440)));
        const abs = days[index].offset * 1440 + (t - index * 1440);
        let i = 1;
        while (i < curve.length - 1 && curve[i].t < abs) i++;
        const a = curve[i - 1];
        const b = curve[i];
        const u = Math.min(1, Math.max(0, (abs - a.t) / (b.t - a.t)));
        return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * u)) / 2;
    };
}

/** Current date and minute-of-day on the Isle of Man. */
export function islandNow(now = new Date()) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/London",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).formatToParts(now).map((p) => [p.type, p.value])
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

/** Formats an ISO date for display without timezone drift. */
export function formatDay(isoDate, options) {
    return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...options });
}
