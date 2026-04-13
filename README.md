# NYT Romance Design Research Bot

An automated research pipeline that analyzes the **New York Times Best Sellers (Combined Print & E-Book Fiction)** list weekly, extracts visual and thematic data from romance titles using AI, generates copyright-safe print-on-demand design concepts, and delivers scored reports via a dashboard, Slack, and Google Sheets.

## Architecture

```
NYT Books API → Ingest → Claude AI Extract → Claude AI Generate → Claude AI Score → Report
                                                                                      ↓
                                                                   SQLite + Slack + Google Sheets
```

### Pipeline Stages

| Stage | Module | Description |
|-------|--------|-------------|
| 1 | `ingest.py` | Fetches the current NYT Best Sellers list via the Books API |
| 2 | `extract.py` | Sends each book's cover + synopsis to Claude for metadata extraction |
| 3 | `generate.py` | Generates 3 copyright-safe design concepts per book |
| 4 | `score.py` | Scores each book on social momentum, design novelty, and audience size |
| 5 | `report.py` | Saves to SQLite, sends Slack summary, exports to Google Sheets |

### Tech Stack

**Backend:** Python 3.11, FastAPI, SQLAlchemy, SQLite, Anthropic Claude API
**Frontend:** React, TypeScript, Vite, TailwindCSS, Recharts, React Router
**Scheduling:** GitHub Actions (weekly cron)
**Delivery:** Slack Webhooks, Google Sheets API

## Setup

### 1. Clone and Install

```bash
git clone <repo-url>
cd nyt-romance-bot

# Backend
cd backend
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment Variables

Copy the `.env` file in `backend/` and fill in your API keys:

```
NYT_API_KEY=your_nyt_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
SLACK_WEBHOOK_URL=your_slack_webhook_url
GOOGLE_SHEETS_CREDENTIALS_FILE=path/to/credentials.json
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id
DASHBOARD_URL=https://your-dashboard-url.com
```

### 3. Run Locally

```bash
# Terminal 1 — Backend
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000

# Terminal 2 — Frontend
cd frontend
npm run dev
```

The frontend proxies `/api` requests to the backend at `localhost:8000`.

### 4. GitHub Actions Secrets

Add these secrets in your GitHub repo settings:

- `NYT_API_KEY`
- `ANTHROPIC_API_KEY`
- `SLACK_WEBHOOK_URL`
- `GOOGLE_SHEETS_CREDENTIALS_FILE`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `DASHBOARD_URL`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/run` | Trigger a new pipeline run |
| `GET` | `/api/status` | Get the latest run status |
| `GET` | `/api/reports` | List all completed runs |
| `GET` | `/api/reports/{run_id}` | Get full report with books and concepts |
| `GET` | `/api/books/{book_id}` | Get a single book with concepts |
| `POST` | `/api/concepts/{id}/favorite` | Toggle favorite on a concept |
| `GET` | `/api/favorites` | Get all favorited concepts (filterable) |

## Frontend Pages

1. **Dashboard** — Latest report with top 3 picks and all books with design concepts
2. **Report History** — Table of all past runs with status and top pick
3. **Book Detail** — Deep dive into a book's visual profile, scores, and 3 design concepts
4. **Favorites** — Filterable grid of all saved design concepts
5. **Run Status** — Live pipeline progress with stage indicators and error logs

## License

Private — All rights reserved.
