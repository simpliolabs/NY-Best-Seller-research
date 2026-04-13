"""
Stage 1 — Data Ingestion
Fetches the NYT Best Sellers lists and enriches each book with Google Books metadata.
"""
import time
import logging
import requests
from typing import List, Dict, Any

from config import NYT_API_KEY, GOOGLE_BOOKS_API_KEY, NYT_LISTS, TOP_N_BOOKS

logger = logging.getLogger(__name__)


def fetch_nyt_bestsellers() -> List[Dict[str, Any]]:
    """
    Fetch the current best sellers from the NYT Books API for the configured
    list names. Returns a deduplicated list of up to TOP_N_BOOKS books.
    """
    all_books: List[Dict[str, Any]] = []
    seen_isbns: set = set()

    for list_name in NYT_LISTS:
        url = (
            f"https://api.nytimes.com/svc/books/v3/lists/current/{list_name}.json"
            f"?api-key={NYT_API_KEY}"
        )
        logger.info(f"Fetching NYT list: {list_name}")

        try:
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            logger.error(f"NYT API error for {list_name}: {e}")
            continue

        books_data = data.get("results", {}).get("books", [])

        for b in books_data:
            isbn = b.get("primary_isbn13", "")
            if isbn in seen_isbns or not isbn:
                continue
            seen_isbns.add(isbn)

            all_books.append({
                "title": b.get("title", "").strip(),
                "author": b.get("author", "").strip(),
                "isbn": isbn,
                "cover_url": b.get("book_image", ""),
                "synopsis": b.get("description", "").strip(),
                "rank": b.get("rank", 0),
                "weeks_on_list": b.get("weeks_on_list", 0),
                "publisher": b.get("publisher", ""),
                "nyt_list": list_name,
            })

            if len(all_books) >= TOP_N_BOOKS:
                break

        if len(all_books) >= TOP_N_BOOKS:
            break

        # Respect rate limits between list calls
        time.sleep(1)

    logger.info(f"Fetched {len(all_books)} books from NYT API")
    return all_books[:TOP_N_BOOKS]


def enrich_with_google_books(books: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    For each book, call the Google Books API to fetch a richer description
    and a higher-resolution cover thumbnail.
    """
    for book in books:
        isbn = book.get("isbn", "")
        if not isbn:
            continue

        url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}"
        if GOOGLE_BOOKS_API_KEY:
            url += f"&key={GOOGLE_BOOKS_API_KEY}"

        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            logger.warning(f"Google Books API error for ISBN {isbn}: {e}")
            continue

        items = data.get("items", [])
        if not items:
            continue

        vol = items[0].get("volumeInfo", {})

        # Use Google's longer description if the NYT one is short
        google_desc = vol.get("description", "")
        if len(google_desc) > len(book.get("synopsis", "")):
            book["synopsis"] = google_desc

        # Use Google's cover if available (higher res)
        image_links = vol.get("imageLinks", {})
        google_cover = (
            image_links.get("thumbnail", "")
            or image_links.get("smallThumbnail", "")
        )
        if google_cover:
            # Google returns http; upgrade to https
            book["cover_url"] = google_cover.replace("http://", "https://")

        # Grab categories for genre filtering
        book["google_categories"] = vol.get("categories", [])

        # Small delay to respect rate limits
        time.sleep(0.3)

    logger.info("Google Books enrichment complete")
    return books


def run_ingestion() -> List[Dict[str, Any]]:
    """
    Full Stage 1 pipeline: fetch NYT books, then enrich with Google Books.
    """
    books = fetch_nyt_bestsellers()
    books = enrich_with_google_books(books)
    return books
