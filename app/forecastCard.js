/**
 * Forecast Card Module
 *
 * Generates HTML for weather forecast cards with dynamic icons and styling
 * based on weather conditions.
 */

import { parseForecastDate, formatRainfall } from "./utils.js";

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
    const { isContext = false, contextType = null } = options;
    const icon = getWeatherIcon(forecast.description);
    const weatherClass = getWeatherConditionClass(forecast.description);

    const date = parseForecastDate(forecast.forecast_date, forecast.published_at);
    const dayName = date.toLocaleDateString("en-GB", { weekday: "long" });
    const dayMonth = date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

    const publishedDate = new Date(forecast.published_at);
    const updateTime = publishedDate.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
    });

    const rainfallIcon = forecast.rainfall && parseFloat(forecast.rainfall) > 0
        ? '<i class="fas fa-tint"></i>'
        : '<i class="fas fa-tint-slash"></i>';

    const contextClass = isContext ? 'context-card' : '';
    const contextTypeClass = contextType ? `context-${contextType}` : '';
    const forecastDateAttr = forecast.forecast_date ? `data-forecast-date="${forecast.forecast_date}"` : '';

    // Simplified card for context (adjacent days)
    if (isContext) {
        const hasTemps = forecast.min_temp != null && forecast.max_temp != null;
        return `
        <div class="forecast-card glassy ${weatherClass} ${contextClass} ${contextTypeClass}" ${forecastDateAttr}>
          <div class="card-bg-anim"></div>
          <div class="card-content">
            <div class="card-header">
              <h2 class="forecast-date">${dayName} <span>${dayMonth}</span></h2>
            </div>
            <div class="context-weather-summary">
              <span class="weather-icon-context">${icon}</span>
              ${hasTemps ? `
              <div class="context-temps">
                <span class="context-temp-min">${forecast.min_temp}°</span>
                <span class="context-temp-sep">/</span>
                <span class="context-temp-max">${forecast.max_temp}°</span>
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
    const windDisplay = [
        forecast.wind_speed != null ? `${forecast.wind_speed} mph` : null,
        forecast.wind_direction
    ].filter(Boolean).join(' ') || null;

    return `
    <div class="forecast-card glassy ${weatherClass}" ${forecastDateAttr}>
      <div class="card-bg-anim"></div>
      <div class="card-content">
        <div class="card-header-compact">
          <div class="header-main">
            <h2 class="forecast-date-compact">${dayName}</h2>
            <span class="forecast-date-sub">${dayMonth}</span>
          </div>
          <div class="header-meta">
            <span class="updated-badge">${updateTime}</span>
          </div>
        </div>

        <div class="weather-hero">
          <div class="hero-icon">
            <span class="weather-icon-lg">${icon}</span>
          </div>
          ${hasTemps ? `
          <div class="hero-temps">
            <div class="temp-high">
              <span class="temp-val">${forecast.max_temp}°</span>
              <span class="temp-lbl">High</span>
            </div>
            <div class="temp-divider"></div>
            <div class="temp-low">
              <span class="temp-val">${forecast.min_temp}°</span>
              <span class="temp-lbl">Low</span>
            </div>
          </div>
          ` : ''}
        </div>

        <div class="weather-details">
          ${windDisplay || forecast.rainfall ? `
          <div class="details-row">
            ${windDisplay ? `
            <div class="detail-item">
              <i class="fas fa-wind"></i>
              <span>${windDisplay}</span>
            </div>
            ` : ''}
            ${forecast.rainfall ? `
            <div class="detail-item">
              ${rainfallIcon}
              <span>${formatRainfall(forecast.rainfall)}</span>
            </div>
            ` : ''}
          </div>
          ` : ''}

          ${forecast.sun || forecast.tides ? `
          <div class="details-row">
            ${forecast.sun ? `
            <div class="detail-item">
              <i class="fas fa-sun"></i>
              <span>${forecast.sun.sunrise} – ${forecast.sun.sunset}</span>
            </div>
            ` : ''}
            ${forecast.tides && forecast.tides.high.length > 0 ? `
            <div class="detail-item">
              <i class="fas fa-water"></i>
              <span>High ${forecast.tides.high.map(t => t.time).join(', ')}</span>
            </div>
            ` : ''}
          </div>
          ` : ''}

          ${forecast.visibility ? `
          <div class="details-row">
            <div class="detail-item detail-full">
              <i class="fas fa-eye"></i>
              <span>${forecast.visibility}</span>
            </div>
          </div>
          ` : ''}
        </div>

        <div class="forecast-description">
          <p>${forecast.description}</p>
        </div>

        ${forecast.wind_details ? `
        <div class="wind-extended">
          <span>${forecast.wind_details}</span>
        </div>
        ` : ''}
      </div>
      ${forecast.comments ? `
      <div class="card-footer">
        <i class="fas fa-info-circle"></i>
        <span>${forecast.comments}</span>
      </div>
      ` : ''}
    </div>
  `;
}
