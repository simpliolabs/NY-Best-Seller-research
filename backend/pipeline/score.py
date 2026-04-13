"""
Stage 4 — Trend Scoring
Uses Claude to score all 10 books on social momentum, design novelty,
and audience size, then ranks them.
"""
import json
import time
import logging
from typing import Dict, Any, List

import anthropic
from pydantic import BaseModel, Field

from config import ANTHROPIC_API_KEY, LLM_MODEL, LLM_MAX_RETRIES, LLM_RETRY_DELAY

logger = logging.getLogger(__name__)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ---------------------------------------------------------------------------
# Pydantic validation models
# ---------------------------------------------------------------------------

class ScoreDimension(BaseModel):
    score: int = Field(ge=1, le=5)
    rationale: str = ""


class BookScore(BaseModel):
    title: str = ""
    social_momentum: ScoreDimension
    design_novelty: ScoreDimension
    audience_size: ScoreDimension
    total_score: int = 0
    is_sleeper_pick: bool = False


# ---------------------------------------------------------------------------
# Prompt loader
# ---------------------------------------------------------------------------

def _load_prompt(filename: str) -> str:
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "prompts", filename)
    with open(path, "r") as f:
        return f.read().strip()


# ---------------------------------------------------------------------------
# Main scoring function
# ---------------------------------------------------------------------------

def score_books(books: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Send all books to Claude in a single batched prompt for scoring.
    Returns the books list sorted by total_score descending.
    """
    system_prompt = _load_prompt("scoring.txt")

    # Build a summary of all books for the prompt
    book_summaries = []
    for i, b in enumerate(books):
        summary = (
            f"Book {i + 1}: \"{b.get('title', 'Unknown')}\"\n"
            f"  Subgenre: {b.get('subgenre', 'unknown')}\n"
            f"  Tropes: {', '.join(b.get('tropes', []))}\n"
            f"  Visual Keywords: {', '.join(b.get('visual_keywords', []))}\n"
            f"  Weeks on NYT list: {b.get('weeks_on_list', 0)}\n"
        )
        book_summaries.append(summary)

    user_text = (
        "Score the following books for print-on-demand design potential:\n\n"
        + "\n".join(book_summaries)
        + "\n\nReturn a JSON array of objects, one per book, in the same order."
    )

    for attempt in range(LLM_MAX_RETRIES + 1):
        try:
            response = client.messages.create(
                model=LLM_MODEL,
                max_tokens=3000,
                system=system_prompt,
                messages=[{"role": "user", "content": user_text}],
            )

            raw_text = response.content[0].text.strip()

            # Strip markdown code fences if present
            if raw_text.startswith("```"):
                raw_text = raw_text.split("\n", 1)[1] if "\n" in raw_text else raw_text[3:]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3]
            raw_text = raw_text.strip()

            parsed = json.loads(raw_text)

            if not isinstance(parsed, list):
                raise ValueError("Expected a JSON array of scores")

            # Apply scores to books
            for i, score_data in enumerate(parsed):
                if i >= len(books):
                    break

                bs = BookScore(**score_data)
                books[i]["social_momentum"] = bs.social_momentum.score
                books[i]["social_momentum_rationale"] = bs.social_momentum.rationale
                books[i]["design_novelty"] = bs.design_novelty.score
                books[i]["design_novelty_rationale"] = bs.design_novelty.rationale
                books[i]["audience_size"] = bs.audience_size.score
                books[i]["audience_size_rationale"] = bs.audience_size.rationale
                books[i]["total_score"] = (
                    bs.social_momentum.score
                    + bs.design_novelty.score
                    + bs.audience_size.score
                )
                books[i]["is_sleeper_pick"] = bs.is_sleeper_pick

            # Sort by total score descending
            books.sort(key=lambda x: x.get("total_score", 0), reverse=True)

            logger.info("Scoring complete. Books ranked by total score.")
            return books

        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"Scoring attempt {attempt + 1} failed: {e}")
            if attempt < LLM_MAX_RETRIES:
                time.sleep(LLM_RETRY_DELAY)

    # If all retries fail, assign default scores
    logger.error("All scoring attempts failed. Assigning default scores.")
    for book in books:
        book.setdefault("social_momentum", 3)
        book.setdefault("social_momentum_rationale", "Default score — scoring failed.")
        book.setdefault("design_novelty", 3)
        book.setdefault("design_novelty_rationale", "Default score — scoring failed.")
        book.setdefault("audience_size", 3)
        book.setdefault("audience_size_rationale", "Default score — scoring failed.")
        book.setdefault("total_score", 9)
        book.setdefault("is_sleeper_pick", False)

    return books
