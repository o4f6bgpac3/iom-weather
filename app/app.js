import { getForecastCardHTML } from "./forecastCard.js";
import { parseForecastDate } from "./utils.js";
import { AskComponent } from "./askComponent.js";
import { CONFIG } from "./config.js";

class WeatherApp {
    constructor() {
        this.API_URL = CONFIG.api.baseUrl;
        this.forecasts = [];
        this.allForecasts = []; // Store all forecasts for navigation
        this.init();
    }

    init() {
        this.dateFilter = document.getElementById("forecast-date");
        this.resetButton = document.getElementById("reset-filter");
        this.forecastContainer = document.getElementById("forecast-container");
        this.loadingElement = document.getElementById("loading");
        this.errorElement = document.getElementById("error-message");
        this.noDataElement = document.getElementById("no-data-message");

        this.setupEventListeners();
        this.loadForecasts();

        // Initialize the Ask component
        this.askComponent = new AskComponent(this.API_URL);
    }

    setupEventListeners() {
        this.dateFilter.addEventListener("change", () => this.handleDateFilter());
        this.resetButton.addEventListener("click", () => this.resetFilter());

        // Delegate click events for context cards (adjacent days)
        this.forecastContainer.addEventListener("click", (e) => {
            const contextCard = e.target.closest(".context-card");
            if (contextCard) {
                const targetDate = contextCard.dataset.forecastDate;
                if (targetDate) {
                    this.navigateToDate(targetDate);
                }
            }
        });
    }

    navigateToDate(dateStr) {
        this.dateFilter.value = dateStr;
        this.handleDateFilter();
    }

    async loadForecasts(selectedDate = null) {
        try {
            this.showLoading();

            if (selectedDate) {
                // Fetch selected date plus adjacent days for context cards
                const prevDate = this.getAdjacentDate(selectedDate, -1);
                const nextDate = this.getAdjacentDate(selectedDate, 1);

                const [prevRes, mainRes, nextRes] = await Promise.all([
                    fetch(`${this.API_URL}?date=${prevDate}`).catch(() => null),
                    fetch(`${this.API_URL}?date=${selectedDate}`),
                    fetch(`${this.API_URL}?date=${nextDate}`).catch(() => null),
                ]);

                if (!mainRes.ok) throw new Error("Failed to fetch forecast data");

                const mainForecasts = await mainRes.json();
                if (!Array.isArray(mainForecasts) || mainForecasts.length === 0) {
                    this.showNoData("No forecast data found for the selected date.");
                    return;
                }

                // Combine all fetched forecasts
                const allFetched = [...mainForecasts];

                if (prevRes?.ok) {
                    const prevForecasts = await prevRes.json();
                    if (Array.isArray(prevForecasts)) allFetched.push(...prevForecasts);
                }

                if (nextRes?.ok) {
                    const nextForecasts = await nextRes.json();
                    if (Array.isArray(nextForecasts)) allFetched.push(...nextForecasts);
                }

                // Merge with existing cache
                this.mergeForecasts(allFetched);
                this.forecasts = this.allForecasts;
            } else {
                // Default view - fetch upcoming forecasts
                const response = await fetch(this.API_URL);
                if (!response.ok) throw new Error("Failed to fetch forecast data");

                const forecasts = await response.json();
                if (!Array.isArray(forecasts) || forecasts.length === 0) {
                    this.showNoData("No forecast data is currently available. Please check back later.");
                    return;
                }

                this.allForecasts = forecasts;
                this.forecasts = forecasts;
            }

            this.displayForecasts(this.forecasts);
        } catch (error) {
            this.showError("Failed to load forecast data. Please try again later.");
            console.error("Error loading forecasts:", error);
        } finally {
            this.hideLoading();
        }
    }

    mergeForecasts(newForecasts) {
        const existingGuids = new Set(this.allForecasts.map(f => f.guid));
        newForecasts.forEach(f => {
            if (!existingGuids.has(f.guid)) {
                this.allForecasts.push(f);
                existingGuids.add(f.guid);
            }
        });
    }

    displayForecasts(forecasts) {
        const selectedDate = this.dateFilter.value;

        if (selectedDate) {
            this.displaySingleDayView(forecasts, selectedDate);
        } else {
            this.displayMultiDayView(forecasts);
        }
    }

    displayMultiDayView(forecasts) {
        const filteredForecasts = this.getLatestForecasts(forecasts);

        if (filteredForecasts.length === 0) {
            this.showNoData("No forecasts available.");
            return;
        }

        this.hideNoData();
        this.forecastContainer.innerHTML = "";
        this.forecastContainer.classList.remove("single-day-view");

        filteredForecasts.forEach((forecast) => {
            const card = this.createForecastCard(forecast);
            this.forecastContainer.appendChild(card);
        });
    }

    displaySingleDayView(forecasts, selectedDate) {
        const mainForecast = this.getHistoricalForecast(forecasts, selectedDate);

        if (mainForecast.length === 0) {
            this.showNoData("No forecasts found for the selected date.");
            return;
        }

        this.hideNoData();
        this.forecastContainer.innerHTML = "";
        this.forecastContainer.classList.add("single-day-view");

        // Get adjacent days
        const prevDate = this.getAdjacentDate(selectedDate, -1);
        const nextDate = this.getAdjacentDate(selectedDate, 1);

        const prevForecast = this.getHistoricalForecast(forecasts, prevDate);
        const nextForecast = this.getHistoricalForecast(forecasts, nextDate);

        // Create the single-day layout container
        const layoutContainer = document.createElement("div");
        layoutContainer.className = "single-day-layout";

        // Previous day context card (if available)
        const prevWrapper = document.createElement("div");
        prevWrapper.className = "context-wrapper context-wrapper-prev";
        if (prevForecast.length > 0) {
            prevWrapper.appendChild(this.createForecastCard(prevForecast[0], { isContext: true, contextType: "prev" }));
        }
        layoutContainer.appendChild(prevWrapper);

        // Main card
        const mainWrapper = document.createElement("div");
        mainWrapper.className = "main-card-wrapper";
        mainWrapper.appendChild(this.createForecastCard(mainForecast[0]));
        layoutContainer.appendChild(mainWrapper);

        // Next day context card (if available)
        const nextWrapper = document.createElement("div");
        nextWrapper.className = "context-wrapper context-wrapper-next";
        if (nextForecast.length > 0) {
            nextWrapper.appendChild(this.createForecastCard(nextForecast[0], { isContext: true, contextType: "next" }));
        }
        layoutContainer.appendChild(nextWrapper);

        this.forecastContainer.appendChild(layoutContainer);
    }

    getAdjacentDate(dateStr, dayOffset) {
        const date = new Date(dateStr + "T12:00:00Z");
        date.setDate(date.getDate() + dayOffset);
        return date.toISOString().split("T")[0];
    }

    getHistoricalForecast(forecasts, selectedDate) {
        const sameDayForecasts = forecasts.filter((f) => {
            const forecastDate = parseForecastDate(f.forecast_date, f.published_at);
            return forecastDate.toISOString().split("T")[0] === selectedDate;
        });

        if (sameDayForecasts.length > 0) {
            return [
                sameDayForecasts.reduce((latest, current) =>
                    new Date(latest.published_at) > new Date(current.published_at) ? latest : current
                ),
            ];
        }
        return [];
    }

    getLatestForecasts(forecasts) {
        const groupedForecasts = forecasts.reduce((acc, forecast) => {
            const forecastDateStr = parseForecastDate(forecast.forecast_date, forecast.published_at)
                .toISOString()
                .split("T")[0];
            if (
                !acc[forecastDateStr] ||
                new Date(acc[forecastDateStr].published_at) < new Date(forecast.published_at)
            ) {
                acc[forecastDateStr] = forecast;
            }
            return acc;
        }, {});

        return Object.values(groupedForecasts)
            .sort((a, b) =>
                parseForecastDate(a.forecast_date, a.published_at) >
                parseForecastDate(b.forecast_date, b.published_at)
                    ? 1
                    : -1
            )
            .slice(0, CONFIG.display.maxForecastsInMultiDayView);
    }

    createForecastCard(forecast, options = {}) {
        const card = document.createElement("div");
        card.innerHTML = getForecastCardHTML(forecast, options);
        return card;
    }

    handleDateFilter() {
        const selectedDate = this.dateFilter.value;
        if (!selectedDate) {
            this.resetFilter();
            return;
        }
        this.loadForecasts(selectedDate);
    }

    resetFilter() {
        this.dateFilter.value = "";
        this.loadForecasts();
    }

    showLoading() {
        this.loadingElement.style.display = "block";
        this.forecastContainer.style.display = "none";
        this.errorElement.style.display = "none";
        if (this.noDataElement) {
            this.noDataElement.style.display = "none";
        }
    }

    hideLoading() {
        this.loadingElement.style.display = "none";
        this.forecastContainer.style.display = "";  // Let CSS handle display
    }

    showError(message) {
        this.errorElement.textContent = message;
        this.errorElement.style.display = "block";
        this.forecastContainer.style.display = "none";
        if (this.noDataElement) {
            this.noDataElement.style.display = "none";
        }
    }

    showNoData(message) {
        if (!this.noDataElement) {
            this.noDataElement = document.createElement("div");
            this.noDataElement.id = "no-data-message";
            this.noDataElement.className = "error-message";
            this.forecastContainer.parentNode.insertBefore(this.noDataElement, this.forecastContainer);
        }
        this.noDataElement.textContent = message;
        this.noDataElement.style.display = "block";
        this.forecastContainer.style.display = "none";
        this.forecastContainer.innerHTML = "";
        this.errorElement.style.display = "none";
    }

    hideNoData() {
        if (this.noDataElement) {
            this.noDataElement.style.display = "none";
        }
        this.forecastContainer.style.display = "";  // Let CSS handle display
    }
}

document.addEventListener("DOMContentLoaded", () => {
    new WeatherApp();
});
