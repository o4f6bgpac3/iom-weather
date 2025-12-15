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
    model: "zai-org-glm-4.6",
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

    // RSS feed settings
    feed: {
        url: "https://www.gov.im/weather/5-day-forecast/Rss5DayForecast",
        refreshThresholdHours: 3,
        expectedForecastDays: 5,
    },
};
