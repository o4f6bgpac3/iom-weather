import { AskComponent } from "./askComponent.js";
import { CONFIG } from "./config.js";
import { buildDays, forecastIsoDate, formatClock, formatDay, islandNow, makeTide } from "./forecastModel.js";
import { STRIP_HEIGHT, renderChips, renderColumns, renderStrip, tideY } from "./tidelineView.js";

/** Minutes of timeline a full-width drag across the scene moves through. */
const STAGE_DRAG_MINUTES = 2880;
/** On-screen pixels per SVG unit the tide strip aims for (sets its height and label size). */
const STRIP_PIXELS_PER_UNIT = 1.25;
const KEY_STEPS = { ArrowLeft: -15, ArrowRight: 15, PageDown: -180, PageUp: 180 };

class WeatherApp {
    constructor() {
        this.API_URL = CONFIG.api.baseUrl;
        this.forecasts = [];
        this.allForecasts = []; // Cache of every forecast fetched this session
        this.days = [];
        this.tideAt = () => null;
        this.todayIndex = -1;
        this.nowMinute = null;
        // Shared with the 3D scene. t = dayIndex * 1440 + minuteOfDay.
        this.view = { t: 0, sel: 0, playing: false };
        this.scene = null;
        this.sceneFailed = false;
        this.renderedChartWidth = 0;
        this.narrow = window.matchMedia("(max-width: 860px)");
        this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        this.init();
    }

    init() {
        this.dateFilter = document.getElementById("forecast-date");
        this.resetButton = document.getElementById("reset-filter");
        this.forecastContainer = document.getElementById("forecast-container");
        this.loadingElement = document.getElementById("loading");
        this.errorElement = document.getElementById("error-message");
        this.noDataElement = document.getElementById("no-data-message");
        this.stage = document.getElementById("stage");
        this.strip = document.getElementById("strip");
        this.chips = document.getElementById("chips");
        this.columns = document.getElementById("days");
        this.whenElement = document.getElementById("when");
        this.whatElement = document.getElementById("what");
        this.playButton = document.getElementById("play");
        this.nowButton = document.getElementById("now");

        this.setupEventListeners();
        this.loadForecasts();

        this.askComponent = new AskComponent(this.API_URL);
    }

    setupEventListeners() {
        this.dateFilter.addEventListener("change", () => this.handleDateFilter());
        this.resetButton.addEventListener("click", () => this.resetFilter());

        // Tide strip: drag or use the arrow keys to move through time.
        this.strip.addEventListener("pointerdown", (e) => {
            this.strip.setPointerCapture(e.pointerId);
            this.scrubTo(e);
        });
        this.strip.addEventListener("pointermove", (e) => {
            if (this.strip.hasPointerCapture(e.pointerId)) this.scrubTo(e);
        });
        this.strip.addEventListener("keydown", (e) => {
            const step = KEY_STEPS[e.key];
            if (!step) return;
            e.preventDefault();
            this.view.playing = false;
            this.setTime(this.view.t + step);
        });

        // Scene: horizontal drag moves through time; vertical swipes still scroll the page.
        let drag = null;
        this.stage.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            drag = { x: e.clientX, t: this.view.t };
            this.stage.setPointerCapture(e.pointerId);
        });
        this.stage.addEventListener("pointermove", (e) => {
            if (!drag) return;
            this.view.playing = false;
            const span = this.narrow.matches ? 1440 : STAGE_DRAG_MINUTES;
            this.setTime(drag.t + ((e.clientX - drag.x) / this.stage.clientWidth) * span);
        });
        const endDrag = () => { drag = null; };
        this.stage.addEventListener("pointerup", endDrag);
        this.stage.addEventListener("pointercancel", endDrag);

        const selectFrom = (e, selector) => {
            const el = e.target.closest(selector);
            if (el) this.selectDay(Number(el.dataset.index));
            return el;
        };
        this.columns.addEventListener("click", (e) => selectFrom(e, ".day"));
        this.columns.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && selectFrom(e, ".day")) e.preventDefault();
        });
        this.chips.addEventListener("click", (e) => selectFrom(e, "button"));

        this.playButton.addEventListener("click", () => {
            this.view.playing = !this.view.playing;
            if (this.view.playing && this.view.t > this.timelineEnd() - 30) this.view.t = 0;
            this.update();
        });
        this.nowButton.addEventListener("click", () => {
            if (this.todayIndex < 0) return;
            this.view.playing = false;
            this.setTime(this.todayIndex * 1440 + this.nowMinute);
        });

        // Redraw the strip when its width changes enough to alter the chart proportions.
        new ResizeObserver(() => {
            if (this.days.length && this.chartWidth() !== this.renderedChartWidth) this.drawStrip();
        }).observe(this.strip);
    }

    async loadForecasts(selectedDate = null) {
        try {
            this.showLoading();

            if (selectedDate) {
                // Fetch the selected date plus the days either side
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

                const allFetched = [...mainForecasts];
                for (const res of [prevRes, nextRes]) {
                    if (!res?.ok) continue;
                    const extra = await res.json().catch(() => null);
                    if (Array.isArray(extra)) allFetched.push(...extra);
                }

                this.mergeForecasts(allFetched);
                this.forecasts = this.allForecasts;
            } else {
                let forecasts = null;
                try {
                    const response = await fetch(this.API_URL);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    forecasts = await response.json();
                } catch (error) {
                    console.error("Error loading forecasts, trying cached copy:", error);
                }

                const fresh = Array.isArray(forecasts) && forecasts.length > 0;
                if (fresh) this.saveCache(forecasts);
                else forecasts = this.loadCache();
                if (!forecasts || forecasts.length === 0) {
                    this.showNoData("No data available.");
                    return;
                }

                this.allForecasts = forecasts;
                this.forecasts = forecasts;
                this.displayForecasts(this.forecasts);
                this.showStaleNoticeIfNeeded(forecasts, !fresh);
                return;
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
        const existingGuids = new Set(this.allForecasts.map((f) => f.guid));
        newForecasts.forEach((f) => {
            if (!existingGuids.has(f.guid)) {
                this.allForecasts.push(f);
                existingGuids.add(f.guid);
            }
        });
    }

    displayForecasts(forecasts) {
        const selectedDate = this.dateFilter.value;
        let picked;
        if (selectedDate) {
            // The selected day with the day before and after, where we have them
            picked = [-1, 0, 1].flatMap((offset) =>
                this.getHistoricalForecast(forecasts, this.getAdjacentDate(selectedDate, offset))
            );
            if (!picked.some((f) => forecastIsoDate(f) === selectedDate)) {
                this.showNoData("No forecasts found for the selected date.");
                return;
            }
        } else {
            picked = this.getLatestForecasts(forecasts);
            if (picked.length === 0) {
                this.showNoData("No forecasts available.");
                return;
            }
        }

        this.hideNoData();
        this.showDays(buildDays(picked), selectedDate || null);
    }

    /** Renders a set of days and points the timeline at "now", or at midday on the focused date. */
    showDays(days, focusDate) {
        this.days = days;
        this.tideAt = makeTide(days);

        const now = islandNow();
        this.todayIndex = days.findIndex((d) => d.date === now.date);
        this.nowMinute = now.minutes;

        const focusIndex = focusDate ? days.findIndex((d) => d.date === focusDate) : -1;
        this.view.playing = false;
        if (focusIndex >= 0) this.view.t = focusIndex * 1440 + 720;
        else if (this.todayIndex >= 0) this.view.t = this.todayIndex * 1440 + now.minutes;
        else this.view.t = 720;

        this.drawStrip();
        renderChips(this.chips, days, this.todayIndex);
        renderColumns(this.columns, days, this.todayIndex);
        this.strip.setAttribute("aria-valuemax", this.timelineEnd() - 1);
        this.nowButton.hidden = this.todayIndex < 0;

        this.ensureScene();
        this.scene?.setDays(days, this.tideAt);
        this.update();
    }

    /** The 3D scene is an enhancement: without WebGL the strip and columns still work. */
    async ensureScene() {
        if (this.scene || this.sceneFailed) return;
        try {
            const { createScene } = await import("./scene.js");
            this.scene = createScene({
                canvas: document.getElementById("scene"),
                stage: this.stage,
                view: this.view,
                narrow: this.narrow,
                reduceMotion: this.reduceMotion,
                onTick: (dt, rate) => this.tick(dt, rate),
            });
            this.scene.setDays(this.days, this.tideAt);
        } catch (error) {
            this.sceneFailed = true;
            this.stage.classList.add("stage-flat");
            console.warn("3D scene unavailable:", error);
        }
    }

    /**
     * Width of one day's chart in SVG units. Scales with the space a day gets on
     * screen so the strip stays a similar height whether it shows one day or five.
     */
    chartWidth() {
        const visibleDays = this.narrow.matches ? 1 : this.days.length;
        const pixels = this.strip.clientWidth / visibleDays;
        return Math.max(200, Math.round(pixels / STRIP_PIXELS_PER_UNIT / 20) * 20);
    }

    drawStrip() {
        this.renderedChartWidth = this.chartWidth();
        renderStrip(this.strip, this.days, this.tideAt, this.renderedChartWidth);
        this.update();
    }

    tick(dt, minutesPerSecond) {
        if (!this.view.playing) return;
        const end = this.timelineEnd() - 1;
        this.view.t += dt * minutesPerSecond;
        if (this.view.t >= end) {
            this.view.t = end;
            this.view.playing = false;
        }
        this.update();
    }

    timelineEnd() {
        return this.days.length * 1440;
    }

    /** Timeline minutes the strip currently spans: every day when wide, the selected day when narrow. */
    stripRange() {
        if (!this.narrow.matches) return [0, this.timelineEnd()];
        const start = this.view.sel * 1440;
        return [start, start + 1440];
    }

    setTime(t) {
        this.view.t = Math.min(this.timelineEnd() - 1, Math.max(0, t));
        this.update();
    }

    selectDay(index) {
        if (!(index >= 0 && index < this.days.length)) return;
        this.view.playing = false;
        this.setTime(index * 1440 + (this.view.t - this.view.sel * 1440));
    }

    scrubTo(event) {
        const rect = this.strip.getBoundingClientRect();
        const [start, end] = this.stripRange();
        this.view.playing = false;
        const t = start + ((event.clientX - rect.left) / rect.width) * (end - start);
        this.setTime(Math.min(end - 1, Math.max(start, t)));
    }

    /** Syncs the heading, playhead and selected day to the current time. */
    update() {
        if (!this.days.length) return;
        const view = this.view;
        view.sel = Math.min(this.days.length - 1, Math.max(0, Math.floor(view.t / 1440)));
        const day = this.days[view.sel];
        const minute = view.t - view.sel * 1440;
        const height = this.tideAt(view.t);

        this.strip.querySelectorAll(".strip-day").forEach((el, i) => el.classList.toggle("is-selected", i === view.sel));
        this.columns.querySelectorAll(".day").forEach((el, i) => el.setAttribute("aria-current", i === view.sel));
        this.chips.querySelectorAll("button").forEach((el, i) => el.setAttribute("aria-pressed", i === view.sel));

        const [start, end] = this.stripRange();
        const playhead = document.getElementById("playhead");
        playhead.style.left = `${((view.t - start) / (end - start)) * 100}%`;
        playhead.style.setProperty("--dot", `${(tideY(height ?? 4) / STRIP_HEIGHT) * 100}%`);

        const dayName = view.sel === this.todayIndex ? "Today" : formatDay(day.date, { weekday: "long" });
        const facts = [day.weather.label];
        if (height !== null) facts.push(`tide ${height.toFixed(1)} m ${this.tideAt(view.t + 5) > height ? "rising" : "falling"}`);
        if (day.hasSun) {
            facts.push(minute < day.sunrise ? `sunrise ${formatClock(day.sunrise)}`
                : minute < day.sunset ? `sunset ${formatClock(day.sunset)}` : "after dark");
        }
        this.whenElement.textContent = `${dayName} ${formatClock(minute)}`;
        this.whatElement.textContent = facts.join(" · ");
        this.strip.setAttribute("aria-valuenow", Math.round(view.t));
        this.strip.setAttribute("aria-valuetext", `${formatDay(day.date, { weekday: "long" })} ${formatClock(minute)}`);
        this.playButton.textContent = view.playing ? "Pause" : "Play";

        this.scene?.requestRender();
    }

    getAdjacentDate(dateStr, dayOffset) {
        const date = new Date(dateStr + "T12:00:00Z");
        date.setUTCDate(date.getUTCDate() + dayOffset);
        return date.toISOString().split("T")[0];
    }

    getHistoricalForecast(forecasts, selectedDate) {
        const sameDayForecasts = forecasts.filter((f) => forecastIsoDate(f) === selectedDate);
        if (sameDayForecasts.length === 0) return [];
        return [
            sameDayForecasts.reduce((latest, current) =>
                new Date(latest.published_at) > new Date(current.published_at) ? latest : current
            ),
        ];
    }

    getLatestForecasts(forecasts) {
        const latestByDate = {};
        for (const forecast of forecasts) {
            const date = forecastIsoDate(forecast);
            if (!latestByDate[date] || new Date(latestByDate[date].published_at) < new Date(forecast.published_at)) {
                latestByDate[date] = forecast;
            }
        }
        return Object.keys(latestByDate)
            .sort()
            .slice(0, CONFIG.display.maxForecastsInMultiDayView)
            .map((date) => latestByDate[date]);
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
        this.loadingElement.hidden = false;
        this.errorElement.hidden = true;
        this.noDataElement.hidden = true;
        this.forecastContainer.classList.add("is-loading");
    }

    saveCache(forecasts) {
        try { localStorage.setItem("iomForecastCache", JSON.stringify(forecasts)); } catch { /* storage unavailable */ }
    }

    loadCache() {
        try {
            const data = JSON.parse(localStorage.getItem("iomForecastCache"));
            return Array.isArray(data) ? data : null;
        } catch {
            return null;
        }
    }

    /** Shows "No data available" above the forecast when nothing covers today. */
    showStaleNoticeIfNeeded(forecasts, fromCache) {
        const today = islandNow().date;
        const hasToday = forecasts.some((f) => forecastIsoDate(f) >= today);
        if (hasToday && !fromCache) return;
        const issued = forecasts.map((f) => f.published_at).sort().at(-1)?.slice(0, 10);
        this.noDataElement.textContent = `No data available${hasToday ? " right now" : " for today"}. Showing the last forecast we have (issued ${issued}).`;
        this.noDataElement.hidden = false;
    }

    hideLoading() {
        this.loadingElement.hidden = true;
        this.forecastContainer.classList.remove("is-loading");
    }

    showError(message) {
        this.errorElement.textContent = message;
        this.errorElement.hidden = false;
        this.noDataElement.hidden = true;
        this.forecastContainer.hidden = true;
    }

    showNoData(message) {
        this.noDataElement.textContent = message;
        this.noDataElement.hidden = false;
        this.errorElement.hidden = true;
        this.forecastContainer.hidden = true;
    }

    hideNoData() {
        this.noDataElement.hidden = true;
        this.forecastContainer.hidden = false;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    new WeatherApp();
});
