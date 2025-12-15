/**
 * Shared utility functions for the IOM Weather Worker.
 */

/**
 * Formats rainfall value by adding "mm" after each numeric value or range.
 * Handles cases like "15-20, but 25-40 on hills" -> "15-20mm, but 25-40mm on hills"
 *
 * NOTE: This implementation is duplicated in app/utils.js for the frontend.
 * Keep both implementations in sync when making changes.
 *
 * @param {string} value - The rainfall value string
 * @returns {string} - The formatted rainfall string with "mm" units
 */
export function formatRainfall(value) {
    if (!value) return value;
    return value.replace(/(\d+(-\d+)?)/g, "$1mm");
}

/**
 * Formats a date string for display in long format.
 * Example: "2025-01-15" -> "Wednesday, 15 January 2025"
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {string} - Formatted date string
 */
export function formatDateLong(dateStr) {
    const date = new Date(dateStr + "T12:00:00Z");
    return date.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

/**
 * Formats a date string for display in short format.
 * Example: "2025-01-15" -> "Wed, 15 Jan"
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {string} - Formatted date string
 */
export function formatDateShort(dateStr) {
    const date = new Date(dateStr + "T12:00:00Z");
    return date.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
    });
}

/**
 * Maps database field names to human-readable names.
 *
 * @param {string} field - Database field name
 * @returns {string} - Human-readable field name
 */
export function formatFieldName(field) {
    const names = {
        min_temp: "minimum temperature",
        max_temp: "maximum temperature",
        wind_speed: "wind speed",
        wind_direction: "wind direction",
        rainfall: "rainfall",
        visibility: "visibility",
        description: "description",
    };
    return names[field] || field;
}

// =============================================================================
// Data Denormalization Utilities
// =============================================================================
// These functions extract structured/numeric data from free-text fields
// in the RSS feed for easier querying and analysis.

/**
 * Parses rainfall string to extract min/max numeric values.
 *
 * Extracts the absolute minimum and maximum from ALL numbers in the string,
 * so qualifiers like "risk of X on hills" are included in the max.
 *
 * Handles various formats found in the RSS feed:
 * - Single value: "0" -> { min: 0, max: 0 }
 * - Simple range: "5-10" -> { min: 5, max: 10 }
 * - Decimal values: "0.5-3" -> { min: 0.5, max: 3 }
 * - Complex: "5-10, risk 15-25 hills" -> { min: 5, max: 25 } (absolute min/max)
 * - With qualifier: "2-8, risk of 15 on hills" -> { min: 2, max: 15 }
 * - With text: "1-5 mainly overnight" -> { min: 1, max: 5 }
 *
 * @param {string} rainfallStr - Raw rainfall string from RSS feed
 * @returns {{min: number|null, max: number|null}} - Parsed min/max values
 */
export function parseRainfallRange(rainfallStr) {
    if (!rainfallStr || typeof rainfallStr !== "string") {
        return { min: null, max: null };
    }

    const trimmed = rainfallStr.trim();

    // Find all numbers in the string (including decimals)
    const allNumbers = trimmed.match(/\d+(?:\.\d+)?/g);

    if (!allNumbers || allNumbers.length === 0) {
        return { min: null, max: null };
    }

    const values = allNumbers.map(n => parseFloat(n));

    return {
        min: Math.min(...values),
        max: Math.max(...values),
    };
}

/**
 * Extracts a normalized visibility code from visibility description.
 *
 * The RSS feed visibility field contains various descriptions:
 * - "Good" -> "good"
 * - "Moderate" -> "moderate"
 * - "Poor" -> "poor"
 * - "Good, falling moderate or poor in rain" -> "good" (uses primary/initial state)
 * - "Moderate or good" -> "moderate" (uses first mentioned)
 * - "Mostly good" -> "good"
 *
 * @param {string} visibilityStr - Raw visibility string from RSS feed
 * @returns {string|null} - Normalized visibility code: "good", "moderate", "poor", or null
 */
export function parseVisibilityCode(visibilityStr) {
    if (!visibilityStr || typeof visibilityStr !== "string") {
        return null;
    }

    const lower = visibilityStr.toLowerCase().trim();

    // Check for visibility indicators at the start (primary state)
    if (lower.startsWith("good") || lower.startsWith("mostly good")) {
        return "good";
    }
    if (lower.startsWith("moderate")) {
        return "moderate";
    }
    if (lower.startsWith("poor")) {
        return "poor";
    }

    // Fallback: look for any mention of visibility terms
    if (lower.includes("good")) {
        return "good";
    }
    if (lower.includes("moderate")) {
        return "moderate";
    }
    if (lower.includes("poor")) {
        return "poor";
    }

    return null;
}
