create table if not exists forecast_items
(
    id              INTEGER primary key AUTOINCREMENT,
    published_at    TEXT        not null,
    forecast_date   TEXT        not null,
    min_temp        INTEGER,
    max_temp        INTEGER,
    wind_speed      INTEGER,
    wind_direction  TEXT,
    description     TEXT,
    wind_details    TEXT,
    visibility      TEXT,
    visibility_code TEXT,
    comments        TEXT,
    guid            TEXT unique not null,
    created_at      DATETIME default current_timestamp,
    rainfall        TEXT,
    rainfall_min    REAL,
    rainfall_max    REAL
);

-- Primary query index: covers date filtering, grouping, and published_at lookups
-- Used by the CTE that finds the best forecast for each date
create index if not exists idx_forecast_published on forecast_items (forecast_date, published_at);

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

-- Flattened view that picks the best forecast per date:
-- prefers same-day forecasts, falls back to the most recent earlier one.
-- Text-to-SQL queries target this view so the LLM never sees the CTE logic.
CREATE VIEW IF NOT EXISTS weather AS
SELECT fc.forecast_date, fc.min_temp, fc.max_temp, fc.wind_speed,
       fc.wind_direction, fc.description, fc.rainfall,
       fc.rainfall_min, fc.rainfall_max, fc.visibility,
       fc.visibility_code, fc.published_at
FROM forecast_items fc
INNER JOIN (
    SELECT forecast_date, COALESCE(
        MAX(CASE WHEN DATE(published_at) = forecast_date THEN published_at END),
        MAX(CASE WHEN DATE(published_at) < forecast_date THEN published_at END)
    ) AS best_pub
    FROM forecast_items
    GROUP BY forecast_date
) best ON fc.forecast_date = best.forecast_date AND fc.published_at = best.best_pub;
