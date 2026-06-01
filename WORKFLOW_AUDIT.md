# Deep Audit: Current State of Production Workflow

## Current Flow (Broken/Disconnected)

```
Niche Hunter → Approve → (dead end — stays in Approved filter)
Pipeline Run → Design Concepts → Concept Library (shows all)
Design Studio → Shows ALL concepts from latest run (not user-selected)
Mockups → Composites design on blank (NO background removal)
```

## Desired Flow (User Request)

```
Niche Hunter → Approve → flows into Concept Library
Concept Library → user picks item → "Edit in Design Studio"
Design Studio → shows ONLY user-selected items (not all)
Design Studio → keeps original + new edited design
Mockups → removes background FIRST → composites on blank
Mockups → "Create Shopify Listing" button → next stage
Delete available everywhere (Library ✓, Mockups ✗, Design Studio ✗)
```

## Key Findings

### 1. Niche Hunter → Concept Library Gap
- `trendPatterns` table has: patternName, adaptedConcept, previewImageUrl, composition, etc.
- `designConcepts` table has: conceptName, format, style, headline, imageUrlA/B/C, etc.
- NO link between them (no `nichePatternId` on designConcepts)
- Approving a pattern just sets `status = "approved"` — nothing else happens
- **Fix needed**: On approve, create a `designConcept` row from the pattern data

### 2. Design Studio Shows Everything
- Currently: fetches ALL concepts from latest run via `revision.getReviewQueue`
- Desired: show ONLY items user explicitly chose to edit from Concept Library
- **Fix needed**: Add a `inStudio` boolean flag or a separate "studio queue" concept
- Simpler: Design Studio takes a `conceptId` URL param, shows only that concept

### 3. Design Studio Keeps Original + Edited
- Already partially works: `revisionRouter` has `submitRevision` (generates new image) and `revertToOriginal`
- Revisions are stored in a separate `revisions` table with `resultImageUrl`
- The original stays on `designConcepts.imageUrlA/B/C`
- **This mostly works already** — just needs the UI entry point from Library

### 4. Delete Everywhere
- Library: ✓ has delete (just added)
- Mockups: ✗ no delete button in UI (backend `regenerate` procedure deletes + re-creates)
- Design Studio: ✗ no delete (has `revertToOriginal` which deletes revisions)
- **Fix needed**: Add delete buttons to Mockups page

### 5. Mockups Background Removal
- Current: `compositeDesignOnMockup` assumes the design is already transparent PNG
- Problem: AI-generated images from Design Studio have backgrounds (t-shirt mockup backgrounds)
- **Fix needed**: Add background removal step before compositing
- Options: use the built-in image generation API with "remove background" prompt, or use a dedicated BG removal service

### 6. Shopify Listing (New Feature)
- No Shopify tables exist in schema
- No Shopify integration code exists
- **Need**: New page "Shopify Listing" with form to create listing from mockup
- Fields: title, description, tags, price, images (from mockups)
- Could be a draft export (JSON/CSV) or actual Shopify API integration

## Schema Changes Needed

1. Add `nichePatternId` to `designConcepts` (nullable, links approved patterns)
2. Add `inStudio` boolean to `designConcepts` (or use URL-based routing)
3. Add `shopify_listings` table (or just a "listing drafts" export)

## UI Changes Needed

1. NicheHunter approve → creates designConcept + navigates to Library
2. Library ConceptCard → "Edit in Design Studio" button → navigates to /design-studio?conceptId=X
3. Design Studio → receives conceptId from URL, shows only that concept
4. Mockups → add delete button per mockup
5. Mockups → add "Create Shopify Listing" button
6. New page: ShopifyListing (or ListingDraft)
