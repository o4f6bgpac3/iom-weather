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
