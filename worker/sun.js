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
