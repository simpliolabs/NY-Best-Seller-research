"""
Stage 5 — Report Assembly & Delivery
Saves data to SQLite, sends Slack summary, and exports to Google Sheets.
"""
import json
import logging
from typing import Dict, Any, List
from datetime import datetime

import requests

from config import SLACK_WEBHOOK_URL, DASHBOARD_URL
from config import GOOGLE_SHEETS_CREDENTIALS_FILE, GOOGLE_SHEETS_SPREADSHEET_ID

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Database save
# ---------------------------------------------------------------------------

def save_run_to_db(run_id: int, scored_books: List[Dict[str, Any]]):
    """
    Persist all books and their design concepts into the SQLite database.
    """
    from database import SessionLocal, Book, DesignConcept, BotRun

    db = SessionLocal()
    try:
        for rank, book_data in enumerate(scored_books, start=1):
            book = Book(
                run_id=run_id,
                rank=rank,
                title=book_data.get("title", ""),
                author=book_data.get("author", ""),
                isbn=book_data.get("isbn", ""),
                cover_url=book_data.get("cover_url", ""),
                synopsis=book_data.get("synopsis", ""),
                subgenre=book_data.get("subgenre", ""),
                character_archetypes=json.dumps(book_data.get("character_archetypes", [])),
                visual_keywords=json.dumps(book_data.get("visual_keywords", [])),
                color_palette=json.dumps(book_data.get("color_palette", [])),
                tropes=json.dumps(book_data.get("tropes", [])),
                social_momentum=book_data.get("social_momentum", 0),
                social_momentum_rationale=book_data.get("social_momentum_rationale", ""),
                design_novelty=book_data.get("design_novelty", 0),
                design_novelty_rationale=book_data.get("design_novelty_rationale", ""),
                audience_size=book_data.get("audience_size", 0),
                audience_size_rationale=book_data.get("audience_size_rationale", ""),
                total_score=book_data.get("total_score", 0),
                is_sleeper_pick=book_data.get("is_sleeper_pick", False),
            )
            db.add(book)
            db.flush()  # Get the book.id

            for concept_data in book_data.get("concepts", []):
                concept = DesignConcept(
                    book_id=book.id,
                    concept_name=concept_data.get("concept_name", ""),
                    description=concept_data.get("description", ""),
                    typography=concept_data.get("typography", ""),
                    imagery=concept_data.get("imagery", ""),
                    texture=concept_data.get("texture", ""),
                    color_palette=json.dumps(concept_data.get("color_palette", [])),
                    style=concept_data.get("style", ""),
                    format=concept_data.get("format", ""),
                    target_audience=concept_data.get("target_audience", ""),
                    is_favorite=False,
                    copyright_flag=concept_data.get("copyright_flag", False),
                    copyright_flag_reason=concept_data.get("copyright_flag_reason", ""),
                )
                db.add(concept)

        # Update the run record
        run = db.query(BotRun).filter(BotRun.id == run_id).first()
        if run:
            run.books_processed = len(scored_books)

        db.commit()
        logger.info(f"Saved {len(scored_books)} books to database for run {run_id}")

    except Exception as e:
        db.rollback()
        logger.error(f"Database save error: {e}")
        raise
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Slack delivery (summary only — avoids truncation)
# ---------------------------------------------------------------------------

def send_slack_summary(scored_books: List[Dict[str, Any]], run_id: int):
    """
    Send a brief Slack summary with the top 3 picks and a link to the dashboard.
    Keeps the message under 3,000 characters to avoid Slack truncation.
    """
    if not SLACK_WEBHOOK_URL:
        logger.warning("No Slack webhook URL configured. Skipping Slack delivery.")
        return

    top_3 = scored_books[:3]
    today = datetime.now().strftime("%B %d, %Y")
    dashboard_link = f"{DASHBOARD_URL}"

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"NYT Romance Design Report — {today}",
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*{len(scored_books)} books analyzed.* Here are the top 3 picks:",
            },
        },
    ]

    for i, book in enumerate(top_3, start=1):
        colors = ", ".join(book.get("color_palette", [])[:3])
        tropes = ", ".join(book.get("tropes", [])[:2])
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*{i}. {book['title']}* by {book['author']}\n"
                    f"Score: *{book.get('total_score', 0)}/15* | "
                    f"Subgenre: {book.get('subgenre', 'N/A')}\n"
                    f"Tropes: {tropes} | Colors: {colors}"
                ),
            },
        })

    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f"<{dashboard_link}|View Full Report on Dashboard>",
        },
    })

    payload = {"blocks": blocks}

    try:
        resp = requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info("Slack summary sent successfully.")
    except requests.RequestException as e:
        logger.error(f"Slack delivery error: {e}")


# ---------------------------------------------------------------------------
# Google Sheets export
# ---------------------------------------------------------------------------

def export_to_google_sheets(scored_books: List[Dict[str, Any]]):
    """
    Append the weekly data to a Google Sheet for tracking.
    """
    if not GOOGLE_SHEETS_CREDENTIALS_FILE or not GOOGLE_SHEETS_SPREADSHEET_ID:
        logger.warning("Google Sheets not configured. Skipping export.")
        return

    try:
        import gspread
        from oauth2client.service_account import ServiceAccountCredentials

        scope = [
            "https://spreadsheets.google.com/feeds",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = ServiceAccountCredentials.from_json_keyfile_name(
            GOOGLE_SHEETS_CREDENTIALS_FILE, scope
        )
        gc = gspread.authorize(creds)
        sheet = gc.open_by_key(GOOGLE_SHEETS_SPREADSHEET_ID).sheet1

        today = datetime.now().strftime("%Y-%m-%d")

        for book in scored_books:
            row = [
                today,
                book.get("title", ""),
                book.get("author", ""),
                book.get("subgenre", ""),
                book.get("total_score", 0),
                book.get("social_momentum", 0),
                book.get("design_novelty", 0),
                book.get("audience_size", 0),
                ", ".join(book.get("tropes", [])),
                ", ".join(book.get("color_palette", [])),
            ]

            # Add concept names
            for concept in book.get("concepts", []):
                row.append(concept.get("concept_name", ""))

            sheet.append_row(row)

        logger.info("Google Sheets export complete.")

    except Exception as e:
        logger.error(f"Google Sheets export error: {e}")
