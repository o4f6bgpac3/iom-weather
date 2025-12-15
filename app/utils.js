/**
 * Shared utility functions for the IOM Weather frontend.
 *
 * NOTE: Some functions (like formatRainfall) are duplicated in worker/utils.js
 * for the backend. Keep both implementations in sync when making changes.
 */

/**
 * Parses a forecast date string and converts relative dates like "Today" and "Tomorrow"
 * into a proper Date object based on the provided published date.
 *
 * @param {string} forecastDateStr - The date string from the forecast (e.g. "Today", "Thursday, 13 February 2025").
 * @param {string|Date} publishedAt - The published date to use as a reference.
 * @returns {Date} - The normalized Date object.
 */
export function parseForecastDate(forecastDateStr, publishedAt) {
    // Attempt a direct date parse
    let dt = new Date(forecastDateStr);
    if (!isNaN(dt)) return dt;

    const lower = forecastDateStr.toLowerCase();

    // Handle relative terms
    if (lower.includes("today")) {
        return new Date(publishedAt);
    }
    if (lower.includes("tomorrow")) {
        let d = new Date(publishedAt);
        d.setDate(d.getDate() + 1);
        return d;
    }

    // Remove weekday names if present (e.g. "Thursday, 13 February 2025")
    const parts = forecastDateStr.split(",");
    if (parts.length > 1) {
        dt = new Date(parts[1].trim());
        if (!isNaN(dt)) return dt;
    }

    // Fallback – return the default parsing result
    return new Date(forecastDateStr);
}

/**
 * Formats rainfall value by adding "mm" after each numeric value or range.
 * Handles cases like "15-20, but 25-40 on hills" → "15-20mm, but 25-40mm on hills"
 *
 * @param {string} value - The rainfall value string
 * @returns {string} - The formatted rainfall string with "mm" units
 */
export function formatRainfall(value) {
    if (!value) return value;
    return value.replace(/(\d+(-\d+)?)/g, "$1mm");
}
