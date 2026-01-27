# Sun & Tides Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use dotperformance:executing-plans to implement this plan task-by-task.

**Goal:** Add sunrise/sunset times and tide information to forecast cards.

**Architecture:** Sun times calculated on-demand from coordinates. Tide data fetched weekly from ADMIRALTY EasyTide API and stored in D1. Both datasets joined to forecast responses and displayed on cards.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), vanilla JavaScript frontend

---

## Task 1: Add Tides Table to Database Schema

**Files:**
- Modify: `worker/database.sql`

**Step 1: Add tides table schema**

Add to `worker/database.sql`:

```sql
-- Tide predictions from ADMIRALTY EasyTide
CREATE TABLE IF NOT EXISTS tides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tide_date DATE NOT NULL,
  tide_time TIME NOT NULL,
  height_metres REAL NOT NULL,
  tide_type TEXT NOT NULL CHECK (tide_type IN ('high', 'low')),
  location TEXT NOT NULL DEFAULT 'Douglas',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tide_date, tide_time, location)
);

CREATE INDEX IF NOT EXISTS idx_tides_date ON tides(tide_date);
```

**Step 2: Commit**

```bash
git add worker/database.sql
git commit -m "feat: add tides table schema"
```

---

## Task 2: Create Sun Calculation Utility

**Files:**
- Create: `worker/sun.js`

**Step 1: Create sun calculation module**

Create `worker/sun.js`:

```javascript
/**
 * Sun calculation module
 *
 * Calculates sunrise/sunset times for a given date and location.
 * Uses simplified astronomical calculations suitable for mid-latitudes.
 *
 * Reference: NOAA Solar Calculator algorithms
 */

// Isle of Man coordinates (Douglas)
const IOM_LATITUDE = 54.15;
const IOM_LONGITUDE = -4.48;

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 */
function toDegrees(radians) {
  return radians * (180 / Math.PI);
}

/**
 * Calculate the Julian day number for a given date
 */
function getJulianDay(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;

  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

/**
 * Calculate sunrise and sunset times for a given date
 *
 * @param {Date} date - The date to calculate for
 * @param {number} latitude - Latitude in decimal degrees
 * @param {number} longitude - Longitude in decimal degrees
 * @returns {Object} - { sunrise: Date, sunset: Date, dayLengthMinutes: number }
 */
function calculateSunTimes(date, latitude = IOM_LATITUDE, longitude = IOM_LONGITUDE) {
  const jd = getJulianDay(date);
  const n = jd - 2451545.0 + 0.0008;

  // Mean solar noon
  const jStar = n - (longitude / 360);

  // Solar mean anomaly
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const MRad = toRadians(M);

  // Equation of center
  const C = 1.9148 * Math.sin(MRad) + 0.02 * Math.sin(2 * MRad) + 0.0003 * Math.sin(3 * MRad);

  // Ecliptic longitude
  const lambda = (M + C + 180 + 102.9372) % 360;
  const lambdaRad = toRadians(lambda);

  // Solar transit
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(MRad) - 0.0069 * Math.sin(2 * lambdaRad);

  // Declination of the sun
  const sinDec = Math.sin(lambdaRad) * Math.sin(toRadians(23.44));
  const dec = Math.asin(sinDec);

  // Hour angle
  const latRad = toRadians(latitude);
  const cosOmega = (Math.sin(toRadians(-0.83)) - Math.sin(latRad) * sinDec) / (Math.cos(latRad) * Math.cos(dec));

  // Check for polar day/night
  if (cosOmega < -1 || cosOmega > 1) {
    return null; // No sunrise/sunset (polar day or night)
  }

  const omega = toDegrees(Math.acos(cosOmega));

  // Calculate sunrise and sunset Julian days
  const jRise = jTransit - (omega / 360);
  const jSet = jTransit + (omega / 360);

  // Convert Julian day to Date
  function julianToDate(jd) {
    const epoch = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
    const msPerDay = 86400000;
    const daysSinceEpoch = jd - 2451545.0;
    return new Date(epoch.getTime() + daysSinceEpoch * msPerDay);
  }

  const sunrise = julianToDate(jRise);
  const sunset = julianToDate(jSet);
  const dayLengthMinutes = Math.round((sunset - sunrise) / 60000);

  return { sunrise, sunset, dayLengthMinutes };
}

/**
 * Format time as HH:MM string
 */
function formatTime(date) {
  return date.toISOString().slice(11, 16);
}

/**
 * Get sun data for a specific date, formatted for API response
 *
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Object} - { sunrise: "HH:MM", sunset: "HH:MM", dayLengthMinutes: number }
 */
export function getSunData(dateStr) {
  const date = new Date(dateStr + 'T12:00:00Z');
  const result = calculateSunTimes(date);

  if (!result) {
    return null;
  }

  return {
    sunrise: formatTime(result.sunrise),
    sunset: formatTime(result.sunset),
    dayLengthMinutes: result.dayLengthMinutes,
  };
}
```

**Step 2: Commit**

```bash
git add worker/sun.js
git commit -m "feat: add sun calculation utility"
```

---

## Task 3: Create Tide Data Fetching Module

**Files:**
- Create: `worker/tides.js`

**Step 1: Create tide fetching module**

Create `worker/tides.js`:

```javascript
/**
 * Tide data module
 *
 * Fetches tide predictions from ADMIRALTY EasyTide API
 * and stores them in the D1 database.
 */

const EASYTIDE_URL = 'https://easytide.admiralty.co.uk/Home/GetPredictionData';
const DOUGLAS_STATION_ID = '0468';

/**
 * Fetch tide data from ADMIRALTY EasyTide API
 *
 * @returns {Promise<Array>} - Array of tide events
 */
async function fetchTideData() {
  const url = `${EASYTIDE_URL}?stationId=${DOUGLAS_STATION_ID}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`EasyTide API error: ${response.status}`);
  }

  const data = await response.json();
  return data.tidalEventList || [];
}

/**
 * Store tide events in the database
 *
 * @param {D1Database} db - D1 database instance
 * @param {Array} events - Tide events from API
 * @returns {Promise<number>} - Number of events stored
 */
async function storeTideEvents(db, events) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tides (tide_date, tide_time, height_metres, tide_type, location)
    VALUES (?, ?, ?, ?, ?)
  `);

  const batch = events.map(event => {
    const dateTime = new Date(event.dateTime);
    const tideDate = dateTime.toISOString().split('T')[0];
    const tideTime = dateTime.toISOString().slice(11, 16);
    const tideType = event.eventType === 0 ? 'high' : 'low';

    return stmt.bind(tideDate, tideTime, event.height, tideType, 'Douglas');
  });

  await db.batch(batch);
  return events.length;
}

/**
 * Fetch and store tide data (called by scheduled job)
 *
 * @param {D1Database} db - D1 database instance
 * @returns {Promise<Object>} - Result summary
 */
export async function refreshTideData(db) {
  console.log('Fetching tide data from EasyTide API');

  try {
    const events = await fetchTideData();
    console.log(`Fetched ${events.length} tide events`);

    const stored = await storeTideEvents(db, events);
    console.log(`Stored ${stored} tide events in database`);

    return { success: true, eventsStored: stored };
  } catch (error) {
    console.error('Failed to refresh tide data:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get tide data for a specific date
 *
 * @param {D1Database} db - D1 database instance
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} - { high: [...], low: [...] }
 */
export async function getTidesForDate(db, dateStr) {
  const query = `
    SELECT tide_time, height_metres, tide_type
    FROM tides
    WHERE tide_date = ?
    ORDER BY tide_time
  `;

  const { results } = await db.prepare(query).bind(dateStr).all();

  const tides = { high: [], low: [] };

  for (const row of results || []) {
    const entry = { time: row.tide_time, height: row.height_metres };
    if (row.tide_type === 'high') {
      tides.high.push(entry);
    } else {
      tides.low.push(entry);
    }
  }

  return tides;
}
```

**Step 2: Commit**

```bash
git add worker/tides.js
git commit -m "feat: add tide data fetching module"
```

---

## Task 4: Update Worker to Include Sun and Tide Data

**Files:**
- Modify: `worker/worker.js`

**Step 1: Import new modules**

Add imports at top of `worker/worker.js` (after existing imports):

```javascript
import { getSunData } from "./sun.js";
import { getTidesForDate, refreshTideData } from "./tides.js";
```

**Step 2: Create helper to enrich forecast with sun/tide data**

Add this function before the `export default` block:

```javascript
/**
 * Enrich forecast data with sun and tide information
 */
async function enrichForecastWithSunAndTides(forecast, env) {
  const dateStr = forecast.forecast_date;

  // Get sun data (calculated)
  const sun = getSunData(dateStr);

  // Get tide data (from database)
  const tides = await getTidesForDate(env.DB, dateStr);

  return {
    ...forecast,
    sun,
    tides: tides.high.length > 0 || tides.low.length > 0 ? tides : null,
  };
}
```

**Step 3: Update getFutureForecasts to enrich data**

Replace the `getFutureForecasts` function:

```javascript
// Retrieve future forecasts from the database, enriched with sun/tide data.
async function getFutureForecasts(env) {
    console.log("Getting future forecasts from database");
    const query = `
        select *
        from forecast_items
        where forecast_date >= date('now')
        order by forecast_date asc, published_at desc
    `;
    const {results} = await env.DB.prepare(query).all();
    console.log(`Retrieved ${results?.length || 0} future forecasts from database`);

    if (!results || results.length === 0) {
        return [];
    }

    // Enrich each forecast with sun and tide data
    const enriched = await Promise.all(
        results.map(forecast => enrichForecastWithSunAndTides(forecast, env))
    );

    return enriched;
}
```

**Step 4: Update getDateForecasts to enrich data**

Replace the `getDateForecasts` function:

```javascript
// Retrieve forecasts for a specific date, enriched with sun/tide data.
async function getDateForecasts(env, date) {
    console.log(`Getting forecasts for date: ${date}`);
    const query = `
        select *
        from forecast_items
        where forecast_date = ?
        order by published_at desc
    `;
    const {results} = await env.DB.prepare(query).bind(date).all();
    console.log(`Retrieved ${results?.length || 0} forecasts for ${date}`);

    if (!results || results.length === 0) {
        return [];
    }

    // Enrich each forecast with sun and tide data
    const enriched = await Promise.all(
        results.map(forecast => enrichForecastWithSunAndTides(forecast, env))
    );

    return enriched;
}
```

**Step 5: Update scheduled handler to refresh tide data**

Replace the `scheduled` handler:

```javascript
    async scheduled(event, env, ctx) {
        console.log("Starting scheduled task");
        try {
            // Refresh weather data
            await fetchAndStoreWeather(env);

            // Refresh tide data (weekly is enough, but running daily is fine)
            await refreshTideData(env.DB);

            console.log("Scheduled task completed successfully");
        } catch (error) {
            console.error("Scheduled task failed:", error);
        }
    },
```

**Step 6: Commit**

```bash
git add worker/worker.js
git commit -m "feat: enrich forecasts with sun and tide data"
```

---

## Task 5: Update Frontend Forecast Card

**Files:**
- Modify: `app/forecastCard.js`

**Step 1: Add sun/tide display to full card**

In `getForecastCardHTML`, add sun and tide sections after the description div (around line 236, before the additional-info section):

Find this block:
```javascript
        <div class="description">${forecast.description}</div>
```

Replace with:
```javascript
        <div class="description">${forecast.description}</div>
        ${forecast.sun ? `
        <div class="sun-info">
          <i class="fas fa-sun"></i>
          <span>${forecast.sun.sunrise} - ${forecast.sun.sunset}</span>
          <span class="day-length">(${formatDayLength(forecast.sun.dayLengthMinutes)})</span>
        </div>
        ` : ''}
        ${forecast.tides ? `
        <div class="tide-info">
          <i class="fas fa-water"></i>
          <span>High: ${forecast.tides.high.map(t => `${t.time} (${t.height.toFixed(1)}m)`).join(' / ')}</span>
        </div>
        ` : ''}
```

**Step 2: Add formatDayLength helper**

Add this function near the top of the file (after the imports):

```javascript
/**
 * Format day length from minutes to human-readable string
 */
function formatDayLength(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
```

**Step 3: Add sun/tide to context cards**

In the context card section (around line 180), add a brief sun display. Find:
```javascript
            <div class="context-description">${forecast.description}</div>
```

Replace with:
```javascript
            <div class="context-description">${forecast.description}</div>
            ${forecast.sun ? `
            <div class="context-sun">
              <i class="fas fa-sun"></i> ${forecast.sun.sunrise} - ${forecast.sun.sunset}
            </div>
            ` : ''}
```

**Step 4: Commit**

```bash
git add app/forecastCard.js
git commit -m "feat: display sun and tide info on forecast cards"
```

---

## Task 6: Add CSS Styles for Sun and Tide Info

**Files:**
- Modify: `app/styles.css` (or equivalent stylesheet)

**Step 1: Find the stylesheet**

Check for CSS file location:
```bash
ls app/*.css
```

**Step 2: Add styles**

Add these styles to the stylesheet:

```css
/* Sun and Tide Info */
.sun-info,
.tide-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.9);
}

.sun-info i,
.tide-info i {
  width: 1.2rem;
  text-align: center;
}

.day-length {
  opacity: 0.7;
  font-size: 0.85rem;
}

.context-sun {
  font-size: 0.8rem;
  opacity: 0.8;
  margin-top: 0.25rem;
}

.context-sun i {
  margin-right: 0.25rem;
}
```

**Step 3: Commit**

```bash
git add app/*.css
git commit -m "feat: add styles for sun and tide info"
```

---

## Task 7: Run Database Migration

**Step 1: Create migration script (for local testing)**

Run the schema update against local D1:

```bash
cd worker
npx wrangler d1 execute iom-weather-db --local --command "CREATE TABLE IF NOT EXISTS tides (id INTEGER PRIMARY KEY AUTOINCREMENT, tide_date DATE NOT NULL, tide_time TIME NOT NULL, height_metres REAL NOT NULL, tide_type TEXT NOT NULL CHECK (tide_type IN ('high', 'low')), location TEXT NOT NULL DEFAULT 'Douglas', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(tide_date, tide_time, location));"
npx wrangler d1 execute iom-weather-db --local --command "CREATE INDEX IF NOT EXISTS idx_tides_date ON tides(tide_date);"
```

**Step 2: Test locally**

```bash
npx wrangler dev
```

Verify:
1. API returns forecasts with `sun` and `tides` fields
2. Frontend displays sun/tide info on cards

**Step 3: Commit any fixes if needed**

---

## Task 8: Final Integration Test and Cleanup

**Step 1: Test the complete flow**

1. Start local dev server: `npx wrangler dev`
2. Trigger scheduled task: `curl -X POST http://localhost:8790/__scheduled`
3. Check API response: `curl http://localhost:8790/`
4. Verify frontend displays correctly

**Step 2: Final commit**

```bash
git add -A
git commit -m "chore: integration testing complete"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add tides table schema | `worker/database.sql` |
| 2 | Create sun calculation utility | `worker/sun.js` |
| 3 | Create tide fetching module | `worker/tides.js` |
| 4 | Update worker to enrich forecasts | `worker/worker.js` |
| 5 | Update frontend forecast cards | `app/forecastCard.js` |
| 6 | Add CSS styles | `app/*.css` |
| 7 | Run database migration | - |
| 8 | Integration test | - |
