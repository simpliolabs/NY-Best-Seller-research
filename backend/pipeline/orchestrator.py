"""
Pipeline Orchestrator
Chains all 5 stages together and manages the run lifecycle in the database.
"""
import json
import logging
import traceback
from typing import List

from database import SessionLocal, BotRun, Book

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


def _update_run_stage(run_id: int, stage: int, label: str):
    """Update the current stage and label for a run in the database."""
    db = SessionLocal()
    try:
        run = db.query(BotRun).filter(BotRun.id == run_id).first()
        if run:
            run.current_stage = stage
            run.stage_label = label
            db.commit()
    finally:
        db.close()


def _get_previous_keywords() -> List[str]:
    """
    Query the most recent completed run and collect all visual_keywords
    used across its books. This is passed to the generation stage to
    prevent repetition.
    """
    db = SessionLocal()
    try:
        last_run = (
            db.query(BotRun)
            .filter(BotRun.status == "completed")
            .order_by(BotRun.run_date.desc())
            .first()
        )
        if not last_run:
            return []

        books = db.query(Book).filter(Book.run_id == last_run.id).all()
        keywords = []
        for book in books:
            try:
                kw = json.loads(book.visual_keywords or "[]")
                keywords.extend(kw)
            except json.JSONDecodeError:
                pass
        return list(set(keywords))
    finally:
        db.close()


def run_full_pipeline(run_id: int):
    """
    Execute the full 5-stage pipeline for a given run_id.
    Updates the database with progress at each stage.
    """
    db = SessionLocal()

    try:
        # ------------------------------------------------------------------
        # Stage 1: Data Ingestion
        # ------------------------------------------------------------------
        _update_run_stage(run_id, 1, "Stage 1 of 5: Fetching NYT Best Sellers...")
        logger.info(f"[Run {run_id}] Stage 1: Data Ingestion")

        from pipeline.ingest import run_ingestion
        books = run_ingestion()

        if not books:
            raise RuntimeError("No books returned from NYT API. Check your API key.")

        logger.info(f"[Run {run_id}] Ingested {len(books)} books")

        # ------------------------------------------------------------------
        # Stage 2: LLM Extraction
        # ------------------------------------------------------------------
        _update_run_stage(run_id, 2, "Stage 2 of 5: Extracting Metadata with AI...")
        logger.info(f"[Run {run_id}] Stage 2: LLM Extraction")

        from pipeline.extract import run_extraction
        books = run_extraction(books)

        # ------------------------------------------------------------------
        # Stage 3: Design Concept Generation
        # ------------------------------------------------------------------
        _update_run_stage(run_id, 3, "Stage 3 of 5: Generating Design Concepts...")
        logger.info(f"[Run {run_id}] Stage 3: Design Concept Generation")

        previous_keywords = _get_previous_keywords()

        from pipeline.generate import run_generation
        books = run_generation(books, previous_keywords)

        # ------------------------------------------------------------------
        # Stage 4: Trend Scoring
        # ------------------------------------------------------------------
        _update_run_stage(run_id, 4, "Stage 4 of 5: Scoring Trends...")
        logger.info(f"[Run {run_id}] Stage 4: Trend Scoring")

        from pipeline.score import score_books
        books = score_books(books)

        # ------------------------------------------------------------------
        # Stage 5: Report Assembly & Delivery
        # ------------------------------------------------------------------
        _update_run_stage(run_id, 5, "Stage 5 of 5: Saving Report & Delivering...")
        logger.info(f"[Run {run_id}] Stage 5: Report Assembly & Delivery")

        from pipeline.report import save_run_to_db, send_slack_summary, export_to_google_sheets

        save_run_to_db(run_id, books)
        send_slack_summary(books, run_id)
        export_to_google_sheets(books)

        # ------------------------------------------------------------------
        # Mark run as completed
        # ------------------------------------------------------------------
        run = db.query(BotRun).filter(BotRun.id == run_id).first()
        if run:
            run.status = "completed"
            run.current_stage = 5
            run.stage_label = "Completed successfully."
            run.books_processed = len(books)
            db.commit()

        logger.info(f"[Run {run_id}] Pipeline completed successfully.")

    except Exception as e:
        # Mark run as failed and log the error
        error_msg = f"{type(e).__name__}: {str(e)}\n{traceback.format_exc()}"
        logger.error(f"[Run {run_id}] Pipeline failed: {error_msg}")

        try:
            run = db.query(BotRun).filter(BotRun.id == run_id).first()
            if run:
                run.status = "failed"
                run.stage_label = f"Failed: {str(e)[:200]}"
                run.error_log = error_msg[:2000]
                db.commit()
        except Exception:
            logger.error(f"[Run {run_id}] Failed to update run status in DB")

    finally:
        db.close()
