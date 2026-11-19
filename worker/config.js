/**
 * Centralized configuration for the IOM Weather Worker.
 * All magic numbers and external URLs are defined here for easy maintenance.
 *
 * LLM settings can be overridden via environment variables:
 *   - LLM_API_URL: API endpoint (default: Venice.ai)
 *   - LLM_MODEL: Model identifier
 *   - LLM_TIMEOUT_MS: Request timeout in milliseconds
 *   - LLM_MAX_RETRIES: Number of retry attempts for server errors
 */

/**
 * Default LLM configuration values.
 * These can be overridden at runtime via getLLMConfig(env).
 */
const LLM_DEFAULTS = {
    apiUrl: "https://api.venice.ai/api/v1/chat/completions",
    model: "llama-3.3-70b",
    timeoutMs: 15000,
    maxRetries: 1,
    temperature: {
        structured: 0.1, // For JSON/structured output
        natural: 0.7,    // For natural language responses
    },
    maxTokens: {
        structured: 500,
        natural: 300,
    },
};

/**
 * Get LLM configuration with environment variable overrides.
 * Call this function with the env object to apply any custom settings.
 *
 * @param {Object} env - Environment bindings from Cloudflare Worker
 * @returns {Object} - LLM configuration with any overrides applied
 */
export function getLLMConfig(env = {}) {
    return {
        apiUrl: env.LLM_API_URL || LLM_DEFAULTS.apiUrl,
        model: env.LLM_MODEL || LLM_DEFAULTS.model,
        timeoutMs: env.LLM_TIMEOUT_MS ? parseInt(env.LLM_TIMEOUT_MS, 10) : LLM_DEFAULTS.timeoutMs,
        maxRetries: env.LLM_MAX_RETRIES ? parseInt(env.LLM_MAX_RETRIES, 10) : LLM_DEFAULTS.maxRetries,
        temperature: LLM_DEFAULTS.temperature,
        maxTokens: LLM_DEFAULTS.maxTokens,
    };
}

export const CONFIG = {
    // LLM defaults (use getLLMConfig(env) for runtime configuration)
    llm: LLM_DEFAULTS,

    // Rate limiting for /ask endpoint
    rateLimit: {
        maxRequests: 5,
        windowSeconds: 86400, // 24 hours
    },

    // CORS settings
    cors: {
        defaultOrigin: "https://iom-weather.pages.dev",
        allowedMethods: "GET, POST, OPTIONS",
        allowedHeaders: "Content-Type",
        maxAge: "86400",
    },

    // Met Office forecast (weather.gov.im JSON API; the gov.im RSS feed was retired)
    feed: {
        url: "https://weather.gov.im/_api/listings/5-day-weather-forecast-listing/_nocache",
        refreshThresholdHours: 3,
        expectedForecastDays: 5,
        // Cron alerts if the newest forecast is older than this. Publishes ~05:00 UTC daily;
        // 30h means the 11:00 UTC run flags a missed day.
        staleAlertHours: 30,
        // Cron fires every 30 min; a full fetch runs at these UTC hours.
        regularHoursUtc: [3, 11, 19],
        // After a failed regular fetch, retry this many minutes later; alert if all fail.
        retryOffsetsMinutes: [30, 60, 120],
        fetchLogRetentionDays: 30,
    },
};
