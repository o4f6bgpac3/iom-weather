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
