/**
 * Forecast Card Module
 *
 * Generates HTML for weather forecast cards with dynamic icons and styling
 * based on weather conditions. Editorial "magazine cover" design approach.
 */

import { parseForecastDate, formatRainfall } from "./utils.js";

/**
 * Wind direction to rotation degree mapping.
 * Converts compass directions to CSS rotation angles.
 */
const WIND_DIRECTIONS = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
    E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
    W: 270, WNW: 292.5, NW: 315, NNW: 337.5
};

/**
 * Get rotation angle for wind direction arrow.
 * @param {string} direction - Compass direction (e.g., "NE", "SSW")
 * @returns {number} Rotation angle in degrees
 */
export function getWindRotation(direction) {
    if (!direction) return 0;
    const normalised = direction.toUpperCase().replace(/\s+/g, '');
    return WIND_DIRECTIONS[normalised] ?? 0;
}

/**
 * Calculate number of rain droplets to display based on rainfall amount.
 * @param {string|number} rainfall - Rainfall in mm (can include "mm" suffix)
 * @returns {number} Number of filled droplets (1-5)
 */
export function getRainDropletCount(rainfall) {
    if (!rainfall) return 0;
    const mm = parseFloat(String(rainfall).replace(/[^\d.]/g, ''));
    if (isNaN(mm) || mm <= 0) return 0;
    if (mm <= 1) return 1;
    if (mm <= 3) return 2;
    if (mm <= 7) return 3;
    if (mm <= 15) return 4;
    return 5;
}

/**
 * Generate rain droplet HTML with filled/empty states.
 * @param {string|number} rainfall - Rainfall amount
 * @returns {string} HTML for droplet display
 */
function getRainDropletsHTML(rainfall) {
    const count = getRainDropletCount(rainfall);
    if (count === 0) {
        return '<span class="droplets-none"><i class="fas fa-tint-slash"></i></span>';
    }
    let html = '<span class="rain-droplets">';
    for (let i = 1; i <= 5; i++) {
        const filled = i <= count ? 'filled' : 'empty';
        html += `<span class="droplet ${filled}"></span>`;
    }
    html += '</span>';
    return html;
}

/**
 * Weather icon selection configuration.
 * Maps weather categories to keywords found in forecast descriptions.
 */
const WEATHER_KEYWORDS = {
    sunny: ["sun", "sunny", "bright", "fine", "clear", "fair"],
    cloudy: ["cloud", "overcast", "gloomy", "dull", "cloudy", "grey", "gray", "variable"],
    rainy: ["rain", "showers", "drizzle", "wet", "downpour", "outbreaks"],
    snowy: ["snow", "wintry", "sleet", "hail", "blizzard"],
};

/** Single-category weather icons */
const SINGLE_ICONS = {
    sunny: "☀️",
    cloudy: "☁️",
    rainy: "🌧️",
    snowy: "❄️",
};

/**
 * Combined weather icons for mixed conditions.
 * Used when two weather categories are both significant in the description.
 */
const SYNERGY_ICONS = {
    "cloudy-sunny": "🌤️",
    "sunny-cloudy": "🌤️",
    "cloudy-rainy": "🌦️",
    "rainy-cloudy": "🌦️",
    "cloudy-snowy": "🌨️",
    "snowy-cloudy": "🌨️",
    "sunny-rainy": "🌦️",
    "rainy-sunny": "🌦️",
    "sunny-snowy": "🌨️",
    "snowy-sunny": "🌨️",
    "rainy-snowy": "🌨️",
    "snowy-rainy": "🌨️",
};

/** Weight applied to keywords preceded by "some" (e.g., "some rain") */
const PARTIAL_WEIGHT = 0.5;

/**
 * Determines the appropriate weather icon based on description text analysis.
 *
 * Algorithm:
 * 1. Tokenize description into words (split on spaces and commas)
 * 2. Score each weather category based on keyword matches:
 *    - Full match: +1.0 point
 *    - Match preceded by "some": +0.5 points (partial conditions)
 * 3. Sort categories by score (highest first)
 * 4. Select icon based on top two categories:
 *    - If only one category has matches: use single icon
 *    - If two categories are close in score: use synergy/combined icon
 *    - "Close" means: second >= 1.0, OR difference <= 0.5
 * 5. Fallback to "⛅" if no keywords match
 *
 * Examples:
 * - "Sunny with some cloud" -> sunny: 1.0, cloudy: 0.5 -> ☀️ (sunny dominant)
 * - "Cloudy with rain" -> cloudy: 1.0, rainy: 1.0 -> 🌦️ (synergy: close scores)
 * - "Heavy rain and cloud" -> rainy: 1.0, cloudy: 1.0 -> 🌦️
 * - "Bright and sunny" -> sunny: 2.0 -> ☀️
 *
 * @param {string} description - Weather description text from forecast
 * @returns {string} - Weather emoji icon
 */
export function getWeatherIcon(description) {
    // Initialize category scores
    const counts = { sunny: 0, cloudy: 0, rainy: 0, snowy: 0 };

    // Tokenize description
    const descWords = description.toLowerCase().split(/\s|,/);

    // Track if the previous word was "some" for partial weight
    let someActive = false;

    // Score each word against weather categories
    for (const word of descWords) {
        if (word === "some") {
            someActive = true;
            continue;
        }

        for (const category of Object.keys(WEATHER_KEYWORDS)) {
            if (WEATHER_KEYWORDS[category].some((keyword) => word.includes(keyword))) {
                counts[category] += someActive ? PARTIAL_WEIGHT : 1;
                someActive = false;
            }
        }
    }

    // Sort categories by score (highest first)
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const topCategory = sorted[0];
    const secondCategory = sorted[1];
    const topScore = counts[topCategory];
    const secondScore = counts[secondCategory];

    // Check if we should use a synergy (combined) icon
    // Conditions: both categories have matches, and they're "close" in score
    const shouldUseSynergy =
        topScore > 0 &&
        secondScore > 0 &&
        (secondScore >= 1 || topScore - secondScore <= PARTIAL_WEIGHT);

    if (shouldUseSynergy) {
        const synergyKey = `${topCategory}-${secondCategory}`;
        if (SYNERGY_ICONS[synergyKey]) {
            return SYNERGY_ICONS[synergyKey];
        }
    }

    // Return single icon for dominant category, or fallback
    return topScore > 0 ? SINGLE_ICONS[topCategory] : "⛅";
}

/**
 * Determines weather condition class directly from description scoring.
 * Does not rely on emoji comparison which can fail due to unicode differences.
 */
export function getWeatherConditionClass(description) {
    const counts = { sunny: 0, cloudy: 0, rainy: 0, snowy: 0 };
    const descWords = description.toLowerCase().split(/\s|,/);
    let someActive = false;

    for (const word of descWords) {
        if (word === "some") {
            someActive = true;
            continue;
        }
        for (const category of Object.keys(WEATHER_KEYWORDS)) {
            if (WEATHER_KEYWORDS[category].some((keyword) => word.includes(keyword))) {
                counts[category] += someActive ? PARTIAL_WEIGHT : 1;
                someActive = false;
            }
        }
    }

    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const topCategory = sorted[0];
    const secondCategory = sorted[1];
    const topScore = counts[topCategory];
    const secondScore = counts[secondCategory];

    // Use synergy class if two categories are close
    const shouldUseSynergy =
        topScore > 0 &&
        secondScore > 0 &&
        (secondScore >= 1 || topScore - secondScore <= PARTIAL_WEIGHT);

    if (shouldUseSynergy) {
        // Map category pairs to CSS classes
        const pair = [topCategory, secondCategory].sort().join("-");
        const synergyClasses = {
            "cloudy-sunny": "weather-sunny-cloudy",
            "cloudy-rainy": "weather-cloudy-rainy",
            "cloudy-snowy": "weather-cloudy-snowy",
            "rainy-sunny": "weather-cloudy-rainy",
            "rainy-snowy": "weather-cloudy-snowy",
            "snowy-sunny": "weather-cloudy-snowy",
        };
        if (synergyClasses[pair]) {
            return synergyClasses[pair];
        }
    }

    // Single category classes
    const singleClasses = {
        sunny: "weather-sunny",
        cloudy: "weather-cloudy",
        rainy: "weather-rainy",
        snowy: "weather-snowy",
    };
    return topScore > 0 ? singleClasses[topCategory] : "weather-cloudy";
}

export function getForecastCardHTML(forecast, options = {}) {
    const { isContext = false, contextType = null, cardIndex = 0 } = options;
    const icon = getWeatherIcon(forecast.description);
    const weatherClass = getWeatherConditionClass(forecast.description);

    const date = parseForecastDate(forecast.forecast_date, forecast.published_at);
    const dayName = date.toLocaleDateString("en-GB", { weekday: "long" });
    const dayMonth = date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

    const contextClass = isContext ? 'context-card' : '';
    const contextTypeClass = contextType ? `context-${contextType}` : '';
    const forecastDateAttr = forecast.forecast_date ? `data-forecast-date="${forecast.forecast_date}"` : '';
    const animationDelay = `style="--card-index: ${cardIndex}"`;

    // Simplified card for context (adjacent days)
    if (isContext) {
        const hasTemps = forecast.min_temp != null && forecast.max_temp != null;
        return `
        <div class="forecast-card glassy ${weatherClass} ${contextClass} ${contextTypeClass}" ${forecastDateAttr} ${animationDelay}>
          <div class="card-bg-anim"></div>
          <div class="weather-effect"></div>
          <div class="card-content">
            <div class="card-header">
              <h2 class="forecast-date">${dayName} <span>${dayMonth}</span></h2>
            </div>
            <div class="context-weather-summary">
              <span class="weather-icon-context">${icon}</span>
              ${hasTemps ? `
              <div class="context-temps">
                <span class="context-temp-max">${forecast.max_temp}°</span>
                <span class="context-temp-sep">/</span>
                <span class="context-temp-min">${forecast.min_temp}°</span>
              </div>
              ` : ''}
            </div>
            <div class="context-description">${forecast.description}</div>
            ${forecast.sun ? `
            <div class="context-sun">
              <i class="fas fa-sun"></i> ${forecast.sun.sunrise} - ${forecast.sun.sunset}
            </div>
            ` : ''}
          </div>
        </div>
      `;
    }

    const hasTemps = forecast.min_temp != null && forecast.max_temp != null;

    // Wind compass data
    const windRotation = getWindRotation(forecast.wind_direction);
    const windSpeed = forecast.wind_speed != null ? `${forecast.wind_speed} mph` : null;

    // Rain droplets
    const rainDroplets = getRainDropletsHTML(forecast.rainfall);
    const rainfallText = forecast.rainfall ? formatRainfall(forecast.rainfall) : null;

    // Build inline horizontal stats
    const visualStats = [];

    if (windSpeed) {
        visualStats.push(`
            <div class="stat-pill wind-pill">
                <div class="compass-mini">
                    <div class="compass-arrow-mini" style="transform: rotate(${windRotation}deg)"></div>
                </div>
                <span>${windSpeed}</span>
            </div>
        `);
    }

    if (forecast.rainfall !== undefined) {
        visualStats.push(`
            <div class="stat-pill rain-pill">
                ${rainDroplets}
                ${rainfallText ? `<span>${rainfallText}</span>` : ''}
            </div>
        `);
    }

    if (forecast.visibility) {
        visualStats.push(`
            <div class="stat-pill vis-pill">
                <i class="fas fa-eye"></i>
                <span>${forecast.visibility}</span>
            </div>
        `);
    }

    // Build combined footer with sun and tides
    const hasFooter = forecast.sun || (forecast.tides && (forecast.tides.high?.length > 0 || forecast.tides.low?.length > 0));
    const cardFooter = hasFooter ? `
        <div class="card-footer-compact">
            ${forecast.sun ? `
                <div class="sun-compact">
                    <i class="fas fa-sun"></i>
                    <span>${forecast.sun.sunrise}</span>
                    <span class="sun-divider">━</span>
                    <span>${forecast.sun.sunset}</span>
                </div>
            ` : ''}
            ${forecast.tides && (forecast.tides.high?.length > 0 || forecast.tides.low?.length > 0) ? `
                <div class="tides-compact">
                    ${forecast.tides.high?.length > 0 ? `<span class="tide-compact high"><i class="fas fa-arrow-up"></i>${forecast.tides.high.map(t => t.time).join(', ')}</span>` : ''}
                    ${forecast.tides.low?.length > 0 ? `<span class="tide-compact low"><i class="fas fa-arrow-down"></i>${forecast.tides.low.map(t => t.time).join(', ')}</span>` : ''}
                </div>
            ` : ''}
        </div>
    ` : '';

    return `
    <div class="forecast-card glassy editorial ${weatherClass}" ${forecastDateAttr} ${animationDelay}>
      <div class="card-bg-anim"></div>
      <div class="weather-effect"></div>
      <div class="card-content">
        <div class="header-compact">
          <div class="header-left">
            <h2 class="day-name-compact">${dayName}</h2>
            <span class="day-date-compact">${dayMonth}</span>
          </div>
          ${hasTemps ? `
          <div class="header-temps">
            <span class="temp-max-compact">${forecast.max_temp}°</span>
            <span class="temp-sep-compact">/</span>
            <span class="temp-min-compact">${forecast.min_temp}°</span>
          </div>
          ` : ''}
          <div class="header-icon-compact">
            <span class="weather-icon-compact">${icon}</span>
          </div>
        </div>

        <div class="stats-inline">
          ${visualStats.join('')}
        </div>

        <div class="card-text-compact">
          <p class="description-text-compact">${forecast.description}</p>
          ${forecast.wind_details ? `
          <div class="wind-inline">
            <i class="fas fa-wind"></i>
            <span>${forecast.wind_details}</span>
          </div>
          ` : ''}
          ${forecast.comments ? `
          <div class="alert-compact">
            <i class="fas fa-exclamation-triangle"></i>
            <span>${forecast.comments}</span>
          </div>
          ` : ''}
        </div>

        ${cardFooter}
      </div>
    </div>
  `;
}
