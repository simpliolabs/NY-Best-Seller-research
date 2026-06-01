# NYT Design Bot — V4 Implementation Plan

## Executive Summary

Six critical product gaps have been identified from user testing of the deployed application. This plan addresses each gap with specific database, backend, and frontend changes. The work is organized into 5 phases, estimated at ~4 hours of implementation.

---

## Root Cause Analysis: "Different Books Between Runs"

After analyzing screenshots of Run #150001 and Run #150003, the finding is clear: **both runs contain the exact same 6 books** (Hope Rises, Faith of Beasts, Project Hail Mary, The Correspondent, Theo of Golden, Yesteryear). The user perceived them as "different" because:

1. **Scores changed** — LLM scoring is non-deterministic, so the same book gets different scores each run
2. **Sort order changed** — Books re-ranked by new scores (Hope Rises was #1 in run 150001, Yesteryear was #1 in run 150003)
3. **No cross-run view exists** — There is no way to see that the same book appeared in both runs

This is not a bug — it is a **missing feature**. The fix is a cross-run book merge view with trend tracking.

---

## Gap 1: Concept Library (New Top-Level Nav)

### Problem
15 AI-generated images exist per run but are buried inside individual book detail pages. No way to browse all concepts across all runs.

### Solution: `/library` Page

| Element | Description |
|---------|-------------|
| **Nav item** | "Concept Library" in sidebar, between Favorites and Run Status |
| **Layout** | Masonry-style thumbnail grid (3-4 columns on desktop, 2 on tablet, 1 on mobile) |
| **Card content** | Thumbnail image, concept name, book title, score, winner badge, run date |
| **Lightbox** | Click any thumbnail → full-screen modal with all 3 image variations (A/B/C), concept details, score breakdown, link to parent book |
| **Filters** | Run date range, book title dropdown, winner-only toggle, score range slider, sort by (score, date, book) |
| **Pagination** | Infinite scroll with 24 concepts per page (lazy-load images) |

### Backend
- New tRPC procedure: `getAllConcepts` — returns all concepts across all runs with book info, images, scores
- Supports pagination (cursor-based), filtering, sorting
- Joins: `design_concepts` → `books` → `bot_runs`

### Database
- No schema changes needed — existing tables have all required data

---

## Gap 2: Cross-Run Book Merge + 30/60/90 Day Trend Charts

### Problem
Each run shows its own isolated set of 6 books. No way to see how a book's metrics evolve over time.

### Solution: `/analytics` Page + Enhanced Dashboard

| Element | Description |
|---------|-------------|
| **Nav item** | "Analytics" in sidebar, between Dashboard and Report History |
| **Book Registry** | Shows ALL unique books ever seen across ALL runs (matched by ISBN) |
| **Book card** | Title, author, total runs appeared in, latest score, trend arrow, mini sparkline |
| **Click → Detail** | Opens trend detail view for that book |
| **Trend Charts** | Line charts (Recharts library) showing metrics over time |
| **Time filters** | 30 / 60 / 90 day toggle buttons |

### Chart Metrics (3 charts per book)

| Chart | Y-Axis | Data Source |
|-------|--------|-------------|
| **Score Trajectory** | socialMomentum, designNovelty, audienceSize (3 lines) | `design_concepts` scores averaged per run |
| **Forum Signal Strength** | Reddit mentions, Goodreads rating, StoryGraph mood count | `books.forumSignals` JSON parsed per run |
| **Concept Signal Strength** | Average concept score, max concept score, concept count | `design_concepts` aggregated per run |

### Backend
- New tRPC procedure: `getBookRegistry` — returns all unique books (deduplicated by ISBN) with latest metrics and appearance count
- New tRPC procedure: `getBookTrendData(isbn, days)` — returns time-series data for charts: all scores, forum signals, concept counts across runs within the date range
- New DB helper: `getUniqueBooksByIsbn()` — GROUP BY isbn, returns latest entry per book
- New DB helper: `getBookHistoryByIsbn(isbn, days)` — returns all book records for that ISBN within date range

### Database
- No schema changes needed — books already have `isbn13` column and are linked to `bot_runs` with `createdAt` timestamps

---

## Gap 3: Per-Book Re-Run

### Problem
Currently the only way to get new data is to run the entire 7-stage pipeline for all 6 books. User wants to refresh a single book's forums, re-score, and generate new concepts without affecting other books.

### Solution: "Refresh This Book" Button on BookDetail Page

| Element | Description |
|---------|-------------|
| **Button** | "Refresh This Book" on BookDetail page header, with refresh icon |
| **What it does** | Re-scrapes all 5 forum sources, re-scores existing concepts, generates 5 NEW concepts (old ones preserved) |
| **Duration** | ~30-60 seconds (1 book instead of 6) |
| **Progress** | Inline progress indicator on the button (spinner → "Scraping forums..." → "Generating concepts..." → "Done!") |
| **Old concepts** | Remain visible, sorted by date (newest first), with "Run #X" or "Refresh #Y" label |
| **New concepts** | Marked with "New" badge, appear at top |

### Backend
- New tRPC procedure: `triggerBookRefresh(bookId)` — runs a mini-pipeline for one book:
  1. Re-scrape all 5 forum sources (Goodreads, StoryGraph, Reddit, Fable, Book Riot)
  2. Update `forumSignals` on the book record
  3. Generate 5 new concepts via LLM (niche-informed, using existing niche research)
  4. Score the 5 new concepts
  5. If any new concept is a top-5 winner globally, generate images
  6. Return updated book data
- New tRPC procedure: `getBookRefreshStatus(bookId)` — returns current refresh progress

### Database
- Add `refreshSource` column to `design_concepts`: enum `'full_run' | 'book_refresh'` (default: `'full_run'`)
- Add `refreshedAt` column to `books`: timestamp of last per-book refresh (nullable)

---

## Gap 4: Winner Clarity + "Why It Won"

### Problem
User cannot easily see which concepts won and why. Winner badges exist but are not prominent enough. No explanation of scoring.

### Solution: Enhanced Winner Display

| Element | Current | Proposed |
|---------|---------|----------|
| **Winner badge** | Small purple badge | Large gold badge with rank number: "Winner #1 of 5" |
| **Image count** | Not shown | "3 images generated" label with camera icon |
| **Why it won** | Not shown | Expandable "Why this won" section showing: top contributing score (socialMomentum: 92), forum signal that boosted it, comparison to runner-up |
| **Dashboard hero** | Shows winner name | Shows winner name + thumbnail grid of all 3 images + "View in Library" CTA |
| **Report page** | Book cards only | Add "Winners" section at top with image thumbnails before book list |

### Backend
- Modify existing `getReport` procedure to include winner rationale data (top score component, margin over #6)
- No new procedures needed

### Database
- No schema changes needed

---

## Gap 5: Image Thumbnails + Lightbox

### Problem
Generated images exist in the database but are not displayed as clickable thumbnails. The 15 images per run are invisible unless you drill into each book.

### Solution: Universal Image Thumbnail + Lightbox System

| Element | Description |
|---------|-------------|
| **Thumbnail component** | Reusable `ImageThumbnail` component: 120x120px rounded corners, lazy-loaded, click to open lightbox |
| **Lightbox component** | Full-screen overlay with: large image, left/right arrows to navigate between variations (A/B/C), concept name + score overlay, "View Book" and "View in Library" links, keyboard navigation (Esc to close, arrows to navigate) |
| **Dashboard** | Winner spotlight shows 3 image thumbnails in a row |
| **BookDetail** | Winner concept shows 3 large images with lightbox on click |
| **Report page** | Each book card shows thumbnail of top concept's image (if winner) |
| **Concept Library** | Full masonry grid of all thumbnails |

### Implementation
- New component: `ImageThumbnail.tsx` — lazy-loaded img with placeholder skeleton
- New component: `ImageLightbox.tsx` — portal-based modal with image gallery navigation
- Update: `ConceptCard.tsx` — use ImageThumbnail for all image displays
- Update: `Dashboard.tsx` — winner hero uses thumbnails
- Update: `BookDetail.tsx` — winner section uses large images with lightbox

---

## Gap 6: Navigation Improvements

### Problem
Sidebar has 5 items but the information architecture doesn't match user mental model. Key pages (Library, Analytics) are missing.

### Solution: Updated Sidebar Navigation

| Position | Current | Proposed |
|----------|---------|----------|
| 1 | Dashboard | Dashboard (unchanged) |
| 2 | Report History | Analytics (NEW — cross-run trends) |
| 3 | Favorites | Concept Library (NEW — all concepts + images) |
| 4 | Run Status | Report History (moved down) |
| 5 | — | Favorites (moved down) |
| 6 | — | Run Status (moved to bottom) |

---

## Implementation Order

| Phase | What | Estimated Time |
|-------|------|----------------|
| **Phase 1** | DB schema changes (refreshSource, refreshedAt) | 15 min |
| **Phase 2** | Backend: 4 new tRPC procedures + DB helpers | 45 min |
| **Phase 3** | Concept Library page (thumbnails, filters, lightbox) | 60 min |
| **Phase 4** | Analytics page (book registry, trend charts) | 60 min |
| **Phase 5** | Per-book refresh button + concept versioning UI | 30 min |
| **Phase 6** | Winner clarity, image thumbnails everywhere, nav reorder | 30 min |
| **Phase 7** | Vitest tests + integration testing | 30 min |

---

## Dependencies

- **Recharts** — lightweight React charting library for trend charts (needs `pnpm add recharts`)
- No other new dependencies required

---

## Questions Resolved

1. **Different books** → Same books, different scores. Fix = cross-run merge view (Analytics page)
2. **Per-book run** → Re-scrape forums + re-score + generate NEW concepts (keep old ones)
3. **Chart metrics** → Social momentum, design novelty, audience size / Forum signal strength / Concept signal strength
4. **Concept Library** → New top-level nav item, ALL concepts ever generated
5. **Image UX** → Recommendation: Masonry thumbnail grid + full-screen lightbox with A/B/C variation navigation

---

## What This Plan Does NOT Include (Explicitly Deferred)

- Vote page / public voting
- Forum agent posting
- Account creation for forum agents
- Etsy API integration (key still returns 403)
- Email capture / pre-launch landing page
