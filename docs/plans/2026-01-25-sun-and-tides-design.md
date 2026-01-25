# Sun & Tides Feature Design

**Date:** 2026-01-25
**Status:** Approved

## Overview

Add sunrise/sunset times and tide information to the weather forecast display. Both features integrate into existing forecast cards.

## Feature 1: Sun & Daylight

### Approach

Calculate at request time using astronomical algorithms. No external data dependency.

### Implementation

- Use `suncalc` library or equivalent formulae
- Input: date + Isle of Man coordinates (54.2°N, 4.5°W)
- Output: sunrise, sunset, day length in minutes

### Database Changes

None required - calculated on demand.

## Feature 2: Tides

### Approach

Fetch tide data weekly from ADMIRALTY EasyTide API and store in D1.

### Data Source

```
https://easytide.admiralty.co.uk/Home/GetPredictionData?stationId=0468
```

Returns 8 days of data including:
- `tidalEventList`: high/low tide times and heights
- `lunarPhaseList`: moon phase information

### Database Schema

```sql
CREATE TABLE tides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tide_date DATE NOT NULL,
  tide_time TIME NOT NULL,
  height_metres REAL NOT NULL,
  tide_type TEXT NOT NULL CHECK (tide_type IN ('high', 'low')),
  location TEXT NOT NULL DEFAULT 'Douglas',
  UNIQUE(tide_date, tide_time, location)
);

CREATE INDEX idx_tides_date ON tides(tide_date);
```

### Scheduled Job

Cloudflare Worker cron runs weekly (Monday 6am UTC):

```toml
[triggers]
crons = ["0 6 * * 1"]
```

Fetches 8 days of data, upserts to D1. The 8-day buffer provides resilience if a fetch fails.

## API Changes

### GET / Response

Add `sun` and `tides` objects to each forecast:

```json
{
  "forecast_date": "2026-01-27",
  "description": "Cloudy with occasional rain",
  "min_temp": 8,
  "max_temp": 12,
  "sun": {
    "sunrise": "08:12",
    "sunset": "16:48",
    "day_length_minutes": 516
  },
  "tides": {
    "high": [
      {"time": "05:15", "height": 5.2},
      {"time": "17:40", "height": 5.4}
    ],
    "low": [
      {"time": "11:33", "height": 1.7}
    ]
  }
}
```

## UI Changes

### Forecast Card Layout

```
+-------------------------------------+
| Monday 27 Jan                       |
| Cloudy, occasional rain             |
| 8C - 12C  |  Wind: 15mph SW         |
|-------------------------------------|
| Sun  08:12 - 16:48  (8h 36m)        |
| Tide High: 05:15 (5.2m) / 17:40 (5.4m) |
+-------------------------------------+
```

### Display Notes

- Sun times shown precisely (calculated, no drift)
- Tide times and heights from ADMIRALTY data
- Heights shown in metres to one decimal place

## Implementation Order

1. Add `tides` table to database schema
2. Implement tide data fetching scheduled job
3. Add sun calculation to API (using suncalc or similar)
4. Add tide data retrieval to API
5. Update frontend forecast cards

## Alternatives Considered

### Tide Data Approaches

| Approach | Pros | Cons |
|----------|------|------|
| ADMIRALTY EasyTide API | Accurate, includes heights, free | External dependency |
| Pure lunar calculation | No dependencies | ~3hr drift/year, no heights |
| WorldTides API | Clean API | ~$1/month cost |
| Scraping tide websites | Free | Fragile, ToS concerns |

**Decision:** EasyTide API provides the best balance of accuracy and simplicity.

### Sun Data Approaches

| Approach | Pros | Cons |
|----------|------|------|
| Calculate at request time | No storage, always accurate | Minor compute cost |
| Pre-calculate and store | Faster queries | Redundant storage |

**Decision:** Calculate at request time - it's a simple formula and avoids storing derivable data.
