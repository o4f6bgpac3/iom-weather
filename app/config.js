/**
 * Centralized configuration for the IOM Weather frontend.
 * All external URLs and display settings are defined here.
 */

/**
 * Detect the API URL at runtime based on the current page location.
 * - Local development (localhost/127.0.0.1): uses local worker on port 8787
 * - Production: uses the configured production worker URL
 *
 * @returns {string} - The API base URL
 */
function detectApiUrl() {
    const hostname = window.location.hostname;

    // Local development
    if (hostname === "localhost" || hostname === "127.0.0.1") {
        return "http://localhost:8787";
    }

    // Production URL
    return "https://iom-weather.r4qavgnsae.workers.dev";
}

export const CONFIG = {
    // API endpoint (detected at runtime)
    api: {
        baseUrl: detectApiUrl(),
    },

    // Display settings
    display: {
        maxForecastsInMultiDayView: 5,
    },
};
