# Isle of Man Weather Forecast

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A weather forecast application for the Isle of Man with AI-powered natural language queries.

## Features

- **5-Day Forecast Display** - View weather forecasts with temperature, wind, rainfall, and visibility
- **Single-Day View** - Detailed view with navigation to adjacent days
- **Natural Language Queries** - Ask questions like "When will it rain?" or "What's the warmest day this week?"
- **Historical Data** - Browse past forecasts and trends
- **Responsive Design** - Works on desktop and mobile devices

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│  Cloudflare Worker   │────▶│  D1 Database    │
│  (Static Site)  │     │       (API)          │     │   (SQLite)      │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  Venice.ai   │
                        │    (LLM)     │
                        └──────────────┘
```

- **Frontend** (`/app`): Vanilla JavaScript with ES6 modules
- **Backend** (`/worker`): Cloudflare Worker with D1 database
- **Data Source**: Isle of Man Government RSS feed
- **AI**: Venice.ai for natural language query processing

## Quick Start

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- Cloudflare account
- [Venice.ai API key](https://venice.ai/)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/iom-weather.git
   cd iom-weather
   ```

2. **Install dependencies**
   ```bash
   cd worker
   npm install
   ```

3. **Configure Wrangler**
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
   Edit `wrangler.toml` with your D1 database ID and KV namespace ID.

4. **Set up secrets**
   ```bash
   wrangler secret put LLM_API_KEY
   ```

5. **Create D1 database**
   ```bash
   wrangler d1 create iom-weather-db
   wrangler d1 execute iom-weather-db --file=schema.sql
   ```

6. **Run locally**
   ```bash
   wrangler dev
   ```

7. **Deploy**
   ```bash
   wrangler deploy
   ```

### Deployment

The worker is deployed manually using `wrangler deploy` from the `worker/` directory.

**Why no automatic deployments?**

The `wrangler.toml` file is gitignored because it contains resource IDs (D1 database, KV namespace) that are specific to each deployment. This allows contributors to fork the project and use their own Cloudflare resources without conflicts.

**For your own fork:**

If you want automatic deployments on git push, you have two options:

1. **Remove from .gitignore**: Delete the `worker/wrangler.toml` line from `.gitignore` and commit your `wrangler.toml`. The resource IDs aren't secrets, just identifiers.

2. **Build-time generation**: In Cloudflare Workers Build settings, set environment variables (`D1_DATABASE_ID`, `KV_NAMESPACE_ID`) and use this build command:
   ```bash
   sed -e "s/YOUR_D1_DATABASE_ID/$D1_DATABASE_ID/" -e "s/YOUR_KV_NAMESPACE_ID/$KV_NAMESPACE_ID/" wrangler.toml.example > wrangler.toml
   ```

### Frontend Development

The frontend is a static site. Simply open `app/index.html` in a browser, or serve it locally:

```bash
cd app
npx serve .
```

## API Endpoints

### GET /
Returns weather forecasts.

**Query Parameters:**
- `date` (optional): Specific date in YYYY-MM-DD format

**Response:**
```json
[
  {
    "forecast_date": "2025-01-15",
    "published_at": "2025-01-15T08:00:00Z",
    "description": "Cloudy with occasional rain",
    "min_temp": 5,
    "max_temp": 10,
    "wind_speed": 15,
    "wind_direction": "SW",
    "rainfall": "5-10",
    "rainfall_min": 5,
    "rainfall_max": 10,
    "visibility": "Good",
    "visibility_code": "good"
  }
]
```

Note: `rainfall_min`, `rainfall_max`, and `visibility_code` are denormalized fields extracted from the raw text values for easier querying.

### POST /ask
Natural language weather queries.

**Request:**
```json
{
  "question": "Will it rain tomorrow?"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "Yes, rain is expected tomorrow with 5-10mm of precipitation.",
  "citations": [
    {
      "forecast_date": "2025-01-16",
      "description": "Rain throughout the day"
    }
  ]
}
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_API_KEY` | Yes | API key for LLM service |
| `LLM_API_URL` | No | LLM API endpoint (default: Venice.ai) |
| `LLM_MODEL` | No | LLM model identifier (default: zai-org-glm-4.6) |
| `LLM_TIMEOUT_MS` | No | Request timeout in ms (default: 15000) |
| `LLM_MAX_RETRIES` | No | Retry attempts for server errors (default: 1) |
| `SMTP2GO_API_KEY` | No | API key for email notifications |
| `NOTIFICATION_EMAIL_TO` | No | Alert recipient email |
| `NOTIFICATION_EMAIL_FROM` | No | Alert sender email |

> **Note:** Venice.ai is the only LLM provider that has been tested. Other OpenAI-compatible APIs should work but have not been verified.

### Rate Limiting

The `/ask` endpoint is rate-limited to 5 requests per day per IP address.

## Technology Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **LLM**: Configurable (default: Venice.ai; other OpenAI-compatible APIs untested)
- **Validation**: Zod

## Security

- SQL injection prevention via parameterized queries
- Input validation with Zod schemas
- Prompt injection detection for LLM queries
- Per-IP rate limiting
- CORS restrictions

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Weather data provided by the [Isle of Man Government](https://www.gov.im/weather/)
- LLM services by [Venice.ai](https://venice.ai/)
