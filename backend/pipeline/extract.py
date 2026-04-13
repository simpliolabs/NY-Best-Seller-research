"""
Stage 2 — LLM Extraction
Uses Claude to extract subgenre, archetypes, visual keywords, color palette,
and tropes from each book's metadata and cover image.
"""
import json
import time
import logging
import base64
import requests
from io import BytesIO
from typing import Dict, Any, Optional

import anthropic
from pydantic import BaseModel, Field
from typing import List

from config import ANTHROPIC_API_KEY, LLM_MODEL, LLM_MAX_RETRIES, LLM_RETRY_DELAY

logger = logging.getLogger(__name__)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ---------------------------------------------------------------------------
# Pydantic validation model for extraction output
# ---------------------------------------------------------------------------

class ExtractionResult(BaseModel):
    subgenre: str = Field(description="Specific romance subgenre")
    character_archetypes: List[str] = Field(description="2-3 main character archetypes")
    visual_aesthetic_keywords: List[str] = Field(description="3-5 visual aesthetic descriptors")
    color_palette: List[str] = Field(description="4-5 hex color codes from the cover")
    trending_tropes: List[str] = Field(description="2-4 romance tropes present in the book")


# ---------------------------------------------------------------------------
# Prompt loader
# ---------------------------------------------------------------------------

def _load_prompt(filename: str) -> str:
    """Load a system prompt from the prompts/ directory."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "prompts", filename)
    with open(path, "r") as f:
        return f.read().strip()


# ---------------------------------------------------------------------------
# Cover image handling
# ---------------------------------------------------------------------------

def _download_cover_as_base64(cover_url: str) -> Optional[str]:
    """Download a cover image and return it as a base64-encoded string."""
    if not cover_url:
        return None
    try:
        resp = requests.get(cover_url, timeout=10)
        resp.raise_for_status()
        return base64.b64encode(resp.content).decode("utf-8")
    except Exception as e:
        logger.warning(f"Failed to download cover image: {e}")
        return None


def _get_media_type(cover_url: str) -> str:
    """Infer the media type from the URL."""
    lower = cover_url.lower()
    if ".png" in lower:
        return "image/png"
    if ".webp" in lower:
        return "image/webp"
    return "image/jpeg"


# ---------------------------------------------------------------------------
# Main extraction function
# ---------------------------------------------------------------------------

def extract_metadata(book: Dict[str, Any]) -> Dict[str, Any]:
    """
    Send the book's synopsis and cover image to Claude and extract
    structured aesthetic metadata.
    """
    system_prompt = _load_prompt("extraction.txt")

    # Build the user message content blocks
    content_blocks = []

    # Include cover image if available
    cover_b64 = _download_cover_as_base64(book.get("cover_url", ""))
    if cover_b64:
        content_blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": _get_media_type(book.get("cover_url", "")),
                "data": cover_b64,
            },
        })

    # Text block with book details
    user_text = (
        f"Title: {book.get('title', 'Unknown')}\n"
        f"Author: {book.get('author', 'Unknown')}\n"
        f"Synopsis: {book.get('synopsis', 'No synopsis available.')}\n"
        f"Weeks on NYT Best Sellers list: {book.get('weeks_on_list', 0)}\n"
    )
    content_blocks.append({"type": "text", "text": user_text})

    # Call Claude with retries
    for attempt in range(LLM_MAX_RETRIES + 1):
        try:
            response = client.messages.create(
                model=LLM_MODEL,
                max_tokens=1024,
                system=system_prompt,
                messages=[{"role": "user", "content": content_blocks}],
            )

            raw_text = response.content[0].text.strip()

            # Strip markdown code fences if present
            if raw_text.startswith("```"):
                raw_text = raw_text.split("\n", 1)[1] if "\n" in raw_text else raw_text[3:]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3]
            raw_text = raw_text.strip()

            parsed = json.loads(raw_text)
            result = ExtractionResult(**parsed)

            # Merge extracted data back into the book dict
            book["subgenre"] = result.subgenre
            book["character_archetypes"] = result.character_archetypes
            book["visual_keywords"] = result.visual_aesthetic_keywords
            book["color_palette"] = result.color_palette
            book["tropes"] = result.trending_tropes

            logger.info(f"Extracted metadata for: {book['title']}")
            return book

        except (json.JSONDecodeError, Exception) as e:
            logger.warning(
                f"Extraction attempt {attempt + 1} failed for '{book.get('title')}': {e}"
            )
            if attempt < LLM_MAX_RETRIES:
                time.sleep(LLM_RETRY_DELAY)

    # If all retries fail, set defaults
    logger.error(f"All extraction attempts failed for: {book.get('title')}")
    book.setdefault("subgenre", "unknown")
    book.setdefault("character_archetypes", [])
    book.setdefault("visual_keywords", [])
    book.setdefault("color_palette", [])
    book.setdefault("tropes", [])
    return book


def run_extraction(books: list) -> list:
    """Run extraction on all books."""
    for book in books:
        extract_metadata(book)
        time.sleep(1)  # Rate limit between LLM calls
    return books
