"""
Configuration module — loads all environment variables from .env
"""
import os
from dotenv import load_dotenv

load_dotenv()

# --- API Keys ---
NYT_API_KEY = os.getenv("NYT_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GOOGLE_BOOKS_API_KEY = os.getenv("GOOGLE_BOOKS_API_KEY", "")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

# --- Google Sheets ---
GOOGLE_SHEETS_CREDENTIALS_FILE = os.getenv("GOOGLE_SHEETS_CREDENTIALS_FILE", "")
GOOGLE_SHEETS_SPREADSHEET_ID = os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID", "")

# --- Dashboard ---
DASHBOARD_URL = os.getenv("DASHBOARD_URL", "http://localhost:5173")

# --- LLM Settings ---
LLM_MODEL = "claude-sonnet-4-6"
LLM_MAX_RETRIES = 2
LLM_RETRY_DELAY = 3  # seconds

# --- NYT API Settings ---
NYT_LISTS = [
    "mass-market-paperback",
    "combined-print-and-e-book-fiction",
]
TOP_N_BOOKS = 10
