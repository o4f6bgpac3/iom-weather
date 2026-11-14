/**
 * Tideline view
 *
 * Renders the tide strip (one chart per day: daylight band, tide curve,
 * high/low water labels), the day chips shown on narrow screens, and the
 * forecast column for each day. All forecast text is escaped before it is
 * placed in the page.
 */

import { TIDE_MAX, escapeHtml, formatClock, formatDay } from "./forecastModel.js";

/** Tide chart height in SVG units, and the y position for a tide height in metres. */
export const STRIP_HEIGHT = 132;
export const tideY = (metres) => 122 - (Math.min(TIDE_MAX, Math.max(0, metres)) / TIDE_MAX) * 52;

const CLOUD = "M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6 11.5 3.3 3.3 0 0 0 7 18z";
const ICONS = {
    sunny: `<g class="sun"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3L7 7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></g>`,
    partly: `<g class="sun"><circle cx="16.5" cy="7.5" r="3"/><path d="M16.5 2.1v1.2M22 7.5h-1.2M20.4 3.6l-.9.9"/></g><path d="${CLOUD}" transform="translate(-1 -1)"/>`,
    cloudy: `<path d="${CLOUD}" transform="translate(0 -2)"/>`,
    rain: `<path d="${CLOUD}" transform="translate(0 -5)"/><path d="M8 16.5l-1.2 4M12.5 16.5l-1.2 4M17 16.5l-1.2 4"/>`,
    showers: `<g class="sun"><circle cx="16.5" cy="7" r="3"/><path d="M16.5 1.6v1.2M22 7h-1.2M20.4 3.1l-.9.9"/></g><path d="${CLOUD}" transform="translate(-1 -3)"/><path d="M8.5 18.5l-.9 3M13.5 18.5l-.9 3"/>`,
    snow: `<path d="${CLOUD}" transform="translate(0 -5)"/><path d="M8 17v.01M12 19v.01M16 17v.01M10 21v.01M14 21.5v.01" stroke-width="2.4"/>`,
};

const weatherIcon = (name) => `<svg class="wx-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.cloudy}</svg>`;

/** Arrow pointing the way the wind is blowing. */
function windArrow(day) {
    if (day.windBearing === null) return "";
    return `<svg class="wind-arrow" viewBox="0 0 24 24" style="transform:rotate(${day.windBearing + 180}deg)" aria-hidden="true"><path d="M12 2l7 10h-5v10h-4V12H5z"/></svg>`;
}

const dayTitle = (day, index, todayIndex, weekday = "long") => (index === todayIndex ? "Today" : formatDay(day.date, { weekday }));
const degrees = (value) => (value === null ? "–" : `${value}°`);

function dayChart(day, index, tideAt, width) {
    const x = (minute) => (minute / 1440) * width;
    const clampLabel = (value) => Math.min(width - 34, Math.max(34, value));
    const hasTide = tideAt(index * 1440) !== null;

    let water;
    let labels;
    if (hasTide) {
        let path = `M0,${STRIP_HEIGHT}`;
        for (let minute = 0; minute <= 1440; minute += 20) {
            path += `L${x(minute).toFixed(1)},${tideY(tideAt(index * 1440 + Math.min(minute, 1439))).toFixed(1)}`;
        }
        water = `<path d="${path}L${width},${STRIP_HEIGHT}Z" fill="var(--sea)"/>`;
        const label = (p, dy, cls) =>
            `<text class="${cls}" x="${clampLabel(x(p.min)).toFixed(1)}" y="${(tideY(p.height) + dy).toFixed(1)}" text-anchor="middle">${formatClock(p.min)} · ${p.height.toFixed(1)}m</text>`;
        labels = day.high.map((p) => label(p, -6, "tide-high")).join("") + day.low.map((p) => label(p, 13, "tide-low")).join("");
    } else {
        water = `<rect y="${tideY(TIDE_MAX / 2)}" width="${width}" height="${STRIP_HEIGHT}" fill="var(--sea)"/>`;
        labels = `<text class="tide-low" x="${width / 2}" y="${tideY(TIDE_MAX / 2) + 16}" text-anchor="middle">No tide data</text>`;
    }

    const rise = x(day.sunrise);
    const set = x(day.sunset);
    const daylight = day.hasSun
        ? `<rect x="${rise}" width="${set - rise}" height="${STRIP_HEIGHT}" fill="var(--daylight)"/>
           <path d="M${rise},46 Q${(rise + set) / 2},4 ${set},46" class="sun-arc"/>
           <text class="sun-time" x="${rise}" y="24" text-anchor="middle">${formatClock(day.sunrise)}</text>
           <text class="sun-time" x="${set}" y="24" text-anchor="middle">${formatClock(day.sunset)}</text>`
        : "";

    return `<svg viewBox="0 0 ${width} ${STRIP_HEIGHT}" aria-hidden="true">
        <rect width="${width}" height="${STRIP_HEIGHT}" fill="var(--night)"/>${daylight}${water}${labels}</svg>`;
}

/**
 * Tide strip: one chart per day plus the playhead.
 * `width` is each chart's width in SVG units; the height is fixed, so a wider
 * value gives a shallower strip with smaller labels.
 */
export function renderStrip(el, days, tideAt, width) {
    el.innerHTML = days.map((day, i) => `<div class="strip-day" data-index="${i}">${dayChart(day, i, tideAt, width)}</div>`).join("")
        + `<div class="playhead" id="playhead"></div>`;
}

/** Day chips, shown instead of side-by-side columns on narrow screens. */
export function renderChips(el, days, todayIndex) {
    el.innerHTML = days.map((day, i) => `
        <button type="button" data-index="${i}" aria-pressed="false">
            ${weatherIcon(day.weather.icon)}
            <b>${escapeHtml(dayTitle(day, i, todayIndex, "short"))}</b>
            <span>${degrees(day.maxTemp)}</span>
        </button>`).join("");
}

/** One forecast column per day. */
export function renderColumns(el, days, todayIndex) {
    el.style.setProperty("--days", days.length);
    el.innerHTML = days.map((day, i) => {
        const windy = (day.windSpeed ?? 0) >= 25;
        const wind = day.windSpeed !== null
            ? `<span class="tag${windy ? " tag-strong" : ""}">${windArrow(day)} ${day.windSpeed} mph ${escapeHtml(day.windDirection ?? "")}</span>`
            : "";
        const rain = day.rainText ? `<span class="tag">${escapeHtml(day.rainText)}</span>` : "";
        const fine = [
            day.windDetails && `Wind: ${escapeHtml(day.windDetails)}`,
            day.visibility && `Visibility: ${escapeHtml(day.visibility)}`,
        ].filter(Boolean).join("<br>");
        return `
        <article class="day" data-index="${i}" tabindex="0" aria-current="false">
            <h2>${escapeHtml(dayTitle(day, i, todayIndex))}</h2>
            <div class="day-date">${escapeHtml(formatDay(day.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}</div>
            <div class="glance">
                ${weatherIcon(day.weather.icon)}
                <div class="glance-temp">${degrees(day.maxTemp)}
                    <small>${escapeHtml(day.weather.label)}${day.minTemp !== null ? ` · low ${day.minTemp}°` : ""}</small>
                </div>
            </div>
            ${wind || rain ? `<div class="tags">${wind}${rain}</div>` : ""}
            ${day.warning ? `<div class="warning">${escapeHtml(day.warning)}</div>` : ""}
            <p class="day-desc">${escapeHtml(day.description)}</p>
            ${fine ? `<p class="day-fine">${fine}</p>` : ""}
        </article>`;
    }).join("");
}
