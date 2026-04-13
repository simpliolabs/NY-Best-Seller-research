"""
Stage 3 — Design Concept Generation
Uses Claude to generate 3 original, copyright-safe design concepts per book.
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
# Pydantic validation model for a single concept
# ---------------------------------------------------------------------------

class SuggestedElements(BaseModel):
    typography: str = ""
    imagery: str = ""
    texture: str = ""


class DesignConceptResult(BaseModel):
    concept_name: str = Field(description="Short, evocative name (2-4 words)")
    design_description: str = Field(description="2-3 sentences describing the visual look")
    suggested_elements: SuggestedElements = Field(default_factory=SuggestedElements)
    color_palette: List[str] = Field(description="3-4 hex codes")
    design_style: str = Field(description="e.g., line art, vintage, minimal")
    best_format: str = Field(description="e.g., t-shirt, hoodie, tote")
    target_audience: str = Field(description="One-sentence demographic note")
    copyright_flag: bool = Field(default=False)
    copyright_flag_reason: str = Field(default="")


# ---------------------------------------------------------------------------
# Prompt loader
# ---------------------------------------------------------------------------

def _load_prompt(filename: str) -> str:
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "prompts", filename)
    with open(path, "r") as f:
        return f.read().strip()


# ---------------------------------------------------------------------------
# Main generation function
# ---------------------------------------------------------------------------

def generate_concepts(
    book: Dict[str, Any],
    previous_keywords: List[str],
) -> List[Dict[str, Any]]:
    """
    Generate 3 original design concepts for a single book.
    Injects previous_keywords into the prompt to prevent repetition.
    """
    system_prompt = _load_prompt("generation.txt")

    # Inject the "do not repeat" constraint
    avoid_list = ", ".join(previous_keywords) if previous_keywords else "None"
    system_prompt = system_prompt.replace("{LAST_WEEK_KEYWORDS}", avoid_list)

    user_text = (
        f"Book aesthetic profile:\n"
        f"- Subgenre: {book.get('subgenre', 'unknown')}\n"
        f"- Character Archetypes: {', '.join(book.get('character_archetypes', []))}\n"
        f"- Visual Aesthetic Keywords: {', '.join(book.get('visual_keywords', []))}\n"
        f"- Color Palette: {', '.join(book.get('color_palette', []))}\n"
        f"- Trending Tropes: {', '.join(book.get('tropes', []))}\n\n"
        f"Generate 3 original design concepts inspired by this aesthetic."
    )

    for attempt in range(LLM_MAX_RETRIES + 1):
        try:
            response = client.messages.create(
                model=LLM_MODEL,
                max_tokens=2048,
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
                parsed = [parsed]

            concepts = []
            for item in parsed[:3]:
                c = DesignConceptResult(**item)
                concepts.append({
                    "concept_name": c.concept_name,
                    "description": c.design_description,
                    "typography": c.suggested_elements.typography,
                    "imagery": c.suggested_elements.imagery,
                    "texture": c.suggested_elements.texture,
                    "color_palette": c.color_palette,
                    "style": c.design_style,
                    "format": c.best_format,
                    "target_audience": c.target_audience,
                    "copyright_flag": c.copyright_flag,
                    "copyright_flag_reason": c.copyright_flag_reason,
                })

            logger.info(f"Generated {len(concepts)} concepts for: {book['title']}")
            return concepts

        except (json.JSONDecodeError, Exception) as e:
            logger.warning(
                f"Generation attempt {attempt + 1} failed for '{book.get('title')}': {e}"
            )
            if attempt < LLM_MAX_RETRIES:
                time.sleep(LLM_RETRY_DELAY)

    logger.error(f"All generation attempts failed for: {book.get('title')}")
    return []


def run_generation(
    books: List[Dict[str, Any]],
    previous_keywords: List[str],
) -> List[Dict[str, Any]]:
    """Run concept generation on all books."""
    for book in books:
        concepts = generate_concepts(book, previous_keywords)
        book["concepts"] = concepts
        time.sleep(1)  # Rate limit between LLM calls
    return books
