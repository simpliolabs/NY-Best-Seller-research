# Niche Hunter System — Full Adversarial Review Brief

**Prepared for:** External adversarial reviewer  
**Date:** 2026-06-01  
**System:** NYT Design Research Bot → Niche Hunter subsystem  
**Live URL:** https://nytdesignbot-2uiwq4um.manus.space  
**Repo:** github.com/simpliolabs/NY-Best-Seller-research  
**Codebase:** 168 files, 35,313 lines TypeScript (server + client + shared)  
**Test suite:** 155 tests across 12 test files (2,400 lines of test code)

---

## Table of Contents

1. [System Purpose & Business Premise](#1-system-purpose--business-premise)
2. [Full Architecture Overview](#2-full-architecture-overview)
3. [The Niche Hunter Pipeline — Step by Step with Verbatim Prompts](#3-the-niche-hunter-pipeline)
4. [The Deep Cultural Map — What It Is and Why It's Broken](#4-the-deep-cultural-map)
5. [Complete Issue History (Every Bug Encountered)](#5-complete-issue-history)
6. [The 9 Latest Pipeline Failures — Root Causes](#6-the-9-latest-pipeline-failures)
7. [Structural Architectural Deficiencies](#7-structural-architectural-deficiencies)
8. [What Actually Works](#8-what-actually-works)
9. [Premises That May Be Wrong](#9-premises-that-may-be-wrong)
10. [File Map](#10-file-map)
11. [Recommendations for Reviewer](#11-recommendations-for-reviewer)
12. [Verdict](#12-verdict)

---

## 1. System Purpose & Business Premise

The system is a **print-on-demand design research tool** that:

1. Finds proven best-selling t-shirt designs in **other niches** (hiking, yoga, fishing, camping, etc.) via the Etsy API
2. Extracts the **visual pattern** that makes each design sell (composition, color strategy, emotional hook)
3. **Adapts** that pattern for the user's target niche (currently: pickleball) — swapping only the subject/activity while preserving the proven visual formula
4. Generates a **preview image** of the adapted design
5. Presents patterns for **human review** (approve/dismiss)
6. Approved designs flow through: Design Studio → Mockup Compositor → Shopify Listing

**The core value proposition:** "Don't invent designs from scratch. Find what's already proven to sell in other markets and transport the visual formula to your niche."

**The business model:** The owner sells DTF-printed shirts on Etsy/Shopify. The tool automates the research + concept generation that a human designer would do manually by browsing Etsy for inspiration.

---

## 2. Full Architecture Overview

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Tailwind 4 + shadcn/ui + wouter |
| Backend | Express 4 + tRPC 11 + Drizzle ORM |
| Database | MySQL/TiDB (hosted) |
| Auth | Manus OAuth (cookie-based sessions) |
| AI | Manus Forge LLM (Gemini 2.5 Flash) + Image Generation |
| Storage | S3 (via Manus Forge) |
| Hosting | Manus Cloud Run (1 vCPU, 512MB RAM, 180s timeout) |

### Application Modules (Full Product Surface)

The app has **two workspace types** sharing the same codebase:

1. **NYT Books workspace** — Original module. Fetches NYT Best Seller list, generates book-themed t-shirt concepts. 7-stage pipeline.
2. **Niche Hunter workspace** — The module under review. Cross-niche Etsy scanning + adaptation. 5-step scan engine.

Both share: Concept Library, Design Studio, Mockup Compositor, Shopify Listings, Analytics, Product Groups.

### Data Model (Key Tables)

```
workspaces          — Multi-tenant workspace container (nicheProfile JSON blob stores everything)
workspace_credentials — Per-workspace secrets (Shopify tokens, etc.)
niche_scan_runs     — Scan execution log (status, progress, patternsFound, errorLog)
trend_patterns      — Individual patterns discovered per scan (source + adaptation + image + score)
design_concepts     — Library concepts (created from approved patterns)
product_groups      — Mockup template groups with print zones
mockup_templates    — Blank shirt images per color
mockup_renders      — Composited design-on-shirt images
shopify_listings    — Draft/published listing records
design_revisions    — Design Studio iteration history
```

### Pipeline Flow Diagram

See attached: `pipeline_flow.png`

```
ONBOARDING (one-time):
  User text → LLM enrichNiche → NicheProfile + culturalMap → DB

SCAN (per-run, 5 steps):
  Step 1:  Etsy API (cross-niche) OR LLM fallback
  Step 1b: Vision LLM style extraction per source image
  Step 2:  "Reddit" signal extraction (LLM — no actual scraping)
  Step 3+4: deconstructAndAdapt (LLM — deconstruct source + adapt for target)
  Step 5:  rankPatterns (LLM — score 0-100)

IMAGE GENERATION (per-pattern, 3 modes):
  edit_source:     Source image + styleJSON → edit reference image
  style_reference: Source image only → generate with style hints
  prompt_only:     No source image → pure text prompt

POST-SCAN:
  Human review → Approve → Library Concept → Design Studio → Mockups → Shopify
```

---

## 3. The Niche Hunter Pipeline

### Step 1: Etsy Source Fetching

**File:** `server/nicheHunter.ts` lines 79-239  
**Function:** `fetchCrossNicheHotSellers(crossNicheCategories, etsyApiKey, etsyKeywords)`

**What it does:**
- Takes the workspace's `crossNicheCategories` array (e.g., ["hiking shirt", "yoga tee", "fishing shirt"])
- Searches Etsy API for each category with `is_best_seller=true` and `sort_on=score`
- Returns up to 2 listings per category (max 16 total)

**Quality filters (added after failures):**
- `MIN_FAVORITES = 500` — skip listings with fewer than 500 favorites
- `TITLE_BLOCKLIST` — 14 terms: custom, personalized, polo, hawaiian, sublimation, etc.

**Fallback:** If Etsy API key is invalid or returns < 4 results, falls back to LLM simulation.

**LLM Fallback Prompt (verbatim):**

```
SYSTEM: You are an Etsy market research expert. Generate realistic top-selling Etsy graphic
t-shirt listings from OTHER niches (NOT the user's own niche).
These must be genuinely high-volume sellers (500+ sales/month) from broad categories like
hiking, camping, yoga, fishing, reading, gardening, nursing, etc.
Return ONLY valid JSON: an array of 8 objects, each with:
- title: string (realistic Etsy listing title for a graphic shirt in that niche)
- category: string (which cross-niche category this belongs to)
- estimatedSales: number (realistic monthly sales, 200-3000 — these are TOP sellers)
- imageDescription: string (describe the design visually in 2-3 sentences — exact composition,
  character poses/positions, text placement, art style, color palette)

USER: Generate 8 top-selling graphic t-shirt designs from these cross-niche categories
(NOT pickleball, NOT the user's niche): hiking shirt, yoga tee, fishing shirt, bowling shirt,
camping tee, golf shirt, tennis shirt, running shirt
```

**Critical issue:** The LLM fallback produces **fictional listings** — they don't exist on Etsy. The `estimatedSales` numbers are invented. There is no way to verify if these "proven patterns" actually sell.

---

### Step 1b: Style Extraction (Vision LLM)

**File:** `server/styleExtractor.ts` (119 lines)  
**Function:** `extractStyleFromImage(imageUrl)`

**What it does:** Sends each source Etsy product image to a Vision LLM and extracts a 20-field structured JSON describing the visual style.

**Vision LLM Prompt (verbatim):**

```
SYSTEM: You are a print-on-demand design expert who analyzes t-shirt product photos.
Your job is to extract the REPRODUCIBLE VISUAL STYLE of the printed graphic — not the shirt itself.
Focus on attributes that a designer could use to recreate the same style for a different subject.
Be precise and specific. Use concrete terms, not vague adjectives.
Return ONLY valid JSON matching the exact schema provided.

USER: [image attached]
Analyze the printed graphic design on this t-shirt product photo.
Extract the visual style into the following JSON structure.
Focus ONLY on the printed artwork — ignore the garment color, background, and props.

Return this exact JSON:
{
  "inkColors": ["list of actual ink colors used in the design"],
  "inkColorNames": ["descriptive names for each ink color"],
  "shirtColorRole": "how the shirt color functions",
  "technique": "one of: screen-print simulation, DTG full-color, vinyl cut, embroidery simulation, watercolor wash",
  "lineWeight": "one of: thick bold outlines, medium outlines, hairline detail, no outlines",
  "shadingMethod": "one of: halftone dots, crosshatch, flat color, gradient, stippling, NONE",
  "textureDetail": "one of: heavy distress/worn, light distress, clean vector, hand-drawn organic, rough brush",
  "subject": "describe the main subject in 3-8 words",
  "subjectCrop": "one of: full body centered, bust portrait, close-up face, object only, scene/landscape",
  "composition": "one of: centered single subject, badge/emblem, left chest logo, full-back scene, stacked text, text-dominant",
  "framingDevice": "one of: circular badge border, banner ribbon, rectangular frame, arc text, NONE",
  "scaleCoverage": "how much of the print area the design fills",
  "textPresence": "describe text placement and style, or NONE",
  "textStyle": "one of: distressed serif all-caps, hand-lettered script, bold sans-serif, retro block letters, NONE",
  "mood": "one of: irreverent humor, vintage nostalgia, aggressive/bold, wholesome/cute, dark/edgy, inspirational",
  "humorMechanism": "one of: absurdist juxtaposition, wordplay/pun, self-deprecating, inside joke, NONE",
  "printMethod": "one of: simulated screen-print, DTG full-color, sublimation, embroidery, vinyl",
  "garmentStyle": "describe the shirt visible in the photo",
  "designEra": "one of: 1970s retro, 1980s neon, 1990s grunge, vintage americana, modern minimal, timeless/classic",
  "backgroundTreatment": "one of: transparent/no background, white rectangle, shirt IS background, colored panel"
}
```

**Output:** `SourceStyleJSON` with 20 fields. Used downstream in `edit_source` mode to lock the art style.

**Failure mode:** Returns `null` if image URL is broken or LLM fails. Non-fatal — scan continues with `style_reference` or `prompt_only` mode.

---

### Step 2: "Reddit" Signal Extraction

**File:** `server/nicheHunter.ts` lines 264-339  
**Function:** `extractInNicheSignals(subreddits, nicheProfile)`

**What it does:** Asks the LLM to generate community signals (phrases, jokes, language, buying triggers) for the target niche.

**CRITICAL: This does NOT scrape Reddit.** It passes subreddit names and cultural context to the LLM and asks it to generate what it thinks the community would say. The signals are **hallucinated**, not scraped.

**LLM Prompt (verbatim):**

```
SYSTEM: You are a community research expert who analyzes niche online communities for
t-shirt design signals.
Return ONLY valid JSON with:
- recurringPhrases: string[] (8-12 actual phrases/slogans this community uses)
- insideJokes: string[] (6-10 inside jokes or memes)
- communityLanguage: string[] (6-10 unique vocabulary/slang terms)
- buyingTriggers: string[] (4-6 emotional reasons this community buys apparel)

USER: Niche: Pickleball players are a rapidly growing community...
Target audience: Active, social adults (primarily 35-65...)
Communities: r/Pickleball, r/pickleballmemes
Known cultural context: Dink responsibly, Stay out of the kitchen, Third shot drop...;
  The 'dink' shot, Staying out of 'the kitchen'...;
  Score amnesia, getting body-bagged...

Extract the most powerful design signals from this community.
```

**Output:** `NicheSignals` with 4 arrays of strings. Fed into Step 3+4.

**Why this is problematic:** The LLM is generating "community signals" from its training data, not from live community observation. These may be stale, generic, or wrong. There is no validation that these phrases are actually used by the community TODAY.

---

### Steps 3+4: Deconstruct & Adapt

**File:** `server/nicheHunter.ts` lines 341-513  
**Function:** `deconstructAndAdapt(hotSellers, nicheSignals, nicheProfile)`

**What it does:** The core intelligence step. Takes each hot seller, deconstructs WHY it works, extracts the transferable pattern, and adapts it for pickleball.

**LLM Prompt (verbatim, including all constraint blocks added after failures):**

```
SYSTEM: You are a print-on-demand design strategist. Your job is to:
1. Deconstruct why each hot-selling listing works (composition, color, emotional hook)
2. Extract the transferable design PATTERN (not the specific content)
3. Adapt that pattern for a completely different niche using the provided community signals
   AND cultural map

=== HARD CONSTRAINT: TRANSFER VALIDATION ===
After adapting each concept, you MUST evaluate whether the core pun, wordplay, or emotional hook
actually works in the TARGET niche — not just the source niche.

Ask: "Does this joke/pun/hook make sense WITHOUT knowing the source niche?"
- YES → transferValid: true, explain briefly in transferReasoning
- NO but CAN be re-anchored → rewrite adaptedConcept with the re-anchored version using
  target niche vocabulary, set transferValid: true, explain in transferReasoning
- NO and CANNOT be re-anchored meaningfully → transferValid: false, explain in transferReasoning

Example:
  Source: "Reel Cool Dinker" (fishing pun — "reel" = fishing reel)
  Naive adaptation: "Reel Cool Dinker" with a fishing rod on a pickleball shirt → INVALID
  Re-anchored: "Real Cool Dinker — Because Dinking IS an Art" → VALID

=== CRITICAL: adaptedConcept FORMAT ===
The "adaptedConcept" field is fed DIRECTLY to an image generator that will edit the source image.
It must describe a 1:1 SUBJECT SWAP that preserves the source layout.

GOOD adaptedConcept: "5 cats in pickleball poses (serving, dinking, volleying, celebrating,
stretching) with title 'Pickleball Master' at top and subtitle 'Still working on my third
shot drop' at bottom"
BAD adaptedConcept: "I'd Rather Be Dinking — funny pickleball quote shirt" (this is a
totally new concept, not a subject swap)

The adaptedConcept must reference the SAME number of elements, SAME layout structure, and
ONLY change what activity/subject is depicted.

=== HARD CONSTRAINT: TARGET NICHE IS PICKLEBALL (Fix #2) ===
The ONLY target niche is PICKLEBALL. Every single adaptedConcept MUST be about pickleball.
NEVER adapt to another sport (soccer, basketball, tennis, etc.). If the source is bowling,
the adaptation is PICKLEBALL — not soccer, not tennis, not anything else.

=== HARD CONSTRAINT: NO ELEMENT INJECTION (Fix #5) ===
The adaptedConcept must contain ONLY elements that exist in the source design:
- If the source has NO animals → the adaptation must have NO animals
- If the source has NO text/slogan → the adaptation must have NO text/slogan
- If the source has 3 characters → the adaptation must have exactly 3 characters
- The cultural map is for VOCABULARY and CONTEXT only — NEVER inject new visual elements

=== HARD CONSTRAINT: NO TEXT INJECTION (Fix #9) ===
- If the source design has NO text/words/slogans, the adaptedConcept must describe a design
  with NO text.
- DO NOT invent slogans like "pickleball is my therapy" or "I'd rather be dinking" unless
  the source already had a slogan.
- If the source HAS text, replace it with pickleball-equivalent text of the SAME length.

=== HARD CONSTRAINT: PICKLEBALL-SPECIFIC VOCABULARY (Fix #8) ===
When text IS present in the source and needs adaptation, use ONLY pickleball-specific terms:
- GOOD: dink, kitchen, third shot drop, paddle, volley, erne, ATP, stacking, skinny singles,
  NVZ, drop shot, rally, bangers, dinkers
- BAD: generic sports phrases like "find your zen on the court", "game day", "love the game"
Every adapted phrase must be UNMISTAKABLY about pickleball to someone who has never seen the source.

USER: TARGET NICHE: Pickleball players are a rapidly growing community...
Audience: Active, social adults (primarily 35-65...)

COMMUNITY SIGNALS:
Recurring phrases: [list]
Inside jokes: [list]
Buying triggers: [list]

CULTURAL MAP (use these for richer, niche-specific adaptations):
Animal mascots that work: Llama (short arms = can't reach high volleys); T-Rex (same joke)
Pain points with humor: Score amnesia → "I forgot the score again" shirt
Physical comedy scenarios: T-Rex arms trying to reach a lob
Rivalries: Pickleball vs tennis — "We stole your courts" humor
Catchphrases: Dink responsibly, Stay out of the kitchen, Third shot drop...

HOT SELLERS TO DECONSTRUCT:
1. "Funny Hiking Bigfoot Shirt" (hiking shirt, ~450 sales/mo)
   Design: Bigfoot silhouette blowing a dandelion, vintage distressed style...
2. "Cat Yoga Poses Shirt" (yoga tee, ~800 sales/mo)
   Design: 5 cats in different yoga poses arranged in a grid...
[etc.]

Deconstruct each hot seller and adapt it for the target niche.
```

**Output:** Array of `DeconstructedPattern` objects:
```typescript
{
  patternName: string;        // "Animal Grid Poses"
  composition: string;        // "5 characters in 2x3 grid"
  colorStrategy: string;      // "black ink on light shirt, vintage distressed"
  emotionalHook: string;      // "cute + relatable hobby obsession"
  transferablePattern: string; // "multiple characters doing niche-specific poses in grid"
  whyItWorks: string;         // "combines cute animals with insider activity knowledge"
  adaptedConcept: string;     // "5 cats in pickleball poses (serving, dinking...)"
  transferValid: boolean;     // true
  transferReasoning: string;  // "Grid of animals doing activity-specific poses transfers directly"
}
```

**Known failure modes (the 9 issues):**
- LLM ignores target niche constraint → adapts to wrong sport
- LLM injects elements not in source (adds animals, adds text)
- LLM uses generic sports phrases instead of pickleball-specific vocabulary
- LLM copies source signatures/watermarks

---

### Step 5: Ranking

**File:** `server/nicheHunter.ts` lines 612-700  
**Function:** `rankPatterns(workspaceId, profile)`

**LLM Prompt (verbatim):**

```
SYSTEM: You are a print-on-demand market analyst. You rank design concepts by their
commercial potential for a specific niche.

Niche: [summary]
Target audience: [audience]
Design styles they love: [styles]
Cultural context / inside jokes: [catchphrases, jokes, moments]

Score each concept from 0-100 based on:
- Market fit (does this match what the audience actually buys?) — 40%
- Originality (is this fresh or overdone?) — 30%
- Emotional resonance (will this make someone say "I NEED that"?) — 30%

Return a JSON array with one object per concept:
[{ "index": 0, "score": 85, "reasoning": "One sentence explaining why" }]

Be harsh. Most concepts should score 40-70. Only truly exceptional ones get 80+.

USER: Rank these [N] concepts: [JSON array of pattern summaries]
```

---

### Image Generation (Three Modes)

**File:** `server/nicheHunter.ts` lines 515-610  
**Function:** `buildGenerationPayload(pattern, mode, sourceImageUrl, sourceStyle)`

#### Mode 1: `edit_source` (highest fidelity)

Used when: source image URL exists AND style extraction succeeded.

**Prompt (verbatim):**

```
Edit this t-shirt design. HARD RULES — you MUST follow ALL of these:

1. KEEP the EXACT same layout — same number of visual elements in the SAME positions.
2. KEEP the EXACT same text placement — title position, subtitle position, font style.
3. KEEP the EXACT same art style: Technique: [X]. Line weight: [X]. Shading: [X].
   Texture: [X]. Colors: [X]. Composition: [X]. Framing: [X]. Text style: [X]. Design era: [X].
4. KEEP the EXACT same color palette and background treatment.
5. ONLY change the SUBJECT/ACTIVITY depicted. If the source shows cats doing yoga poses,
   change them to cats doing PICKLEBALL poses in the SAME grid positions.
6. The new subject/activity is: [adaptedConcept from Step 3+4].

=== ABSOLUTE PROHIBITIONS ===
7. DO NOT add any text, words, or slogans that are NOT in the original design.
8. DO NOT add any animals, characters, or visual elements that are NOT in the original design.
9. If the source has a signature, watermark, or artist mark at the bottom, REMOVE it entirely.
10. The ONLY change is: replace the depicted activity/subject with pickleball. Nothing else changes.

Think of this as a find-and-replace on the ACTIVITY only. Everything else stays pixel-identical.
Output: transparent background, print-ready art, no shirt visible.
```

**originalImages:** `[{ url: sourceImageUrl, mimeType: "image/jpeg" }]`

#### Mode 2: `style_reference` (medium fidelity)

Used when: source image exists but style extraction failed.

```
Create a t-shirt graphic design inspired by the visual style of the reference image.
New subject: [adaptedConcept]. Composition: [composition]. Color approach: [colorStrategy].
Mood: [emotionalHook]. Match the overall artistic style, technique, and era of the reference.
Transparent background, print-ready DTF art, no shirt visible.
```

#### Mode 3: `prompt_only` (lowest fidelity)

Used when: no source image available (LLM fallback path).

```
T-shirt graphic design: [adaptedConcept]. Composition: [composition].
Color palette: [colorStrategy]. Style: print-on-demand apparel art.
Transparent background, centered design, no shirt visible.
```

---

## 4. The Deep Cultural Map

### What It Is

The Deep Cultural Map is a structured JSON object generated during workspace onboarding. It contains 9 categories:

| Category | Fields | Purpose |
|----------|--------|---------|
| animalMascots | animal, whyItWorks, visualTreatment | Know which animals to swap (bigfoot→llama) |
| painPoints | pain, humorAngle | Frustrations that make good shirt concepts |
| funPoints | joy, visualConcept | Joyful moments with visual potential |
| insideJokes | joke, context | Insider references for authenticity |
| physicalComedy | scenario, whyFunny | Funny poses/movements for illustrations |
| catchphrases | string[] | Real community phrases for text designs |
| lifestyleIdentity | trait, purchaseDriver | Why people buy niche apparel |
| rivalries | rivalry, tension, humorAngle | Us-vs-them humor potential |
| transferableVisualConcepts | sourceNiche, sourcePattern, targetAdaptation, whyItTransfers | Pre-mapped cross-niche formulas |

### Where It's Generated

**File:** `server/onboardingRouter.ts` → `enrichNiche` mutation  
The LLM generates the full cultural map as part of the `NicheProfile` during workspace creation. It IS stored in the database as part of the `nicheProfile` JSON blob on the `workspaces` table.

### Where It's Broken

| Location | What's Wrong |
|----------|-------------|
| **Wizard UI (Step 3)** | The cultural map is **NOT shown** to the user. Step 3 only renders: summary, targetAudience, subreddits, etsyKeywords, crossNicheCategories, culturalMoments, designStyles, avoidTopics. The deep cultural map is generated but invisible. |
| **workspace.update router** | The `nicheProfile` Zod schema in `workspaceRouter.ts` line 68-77 does **NOT include culturalMap**. If the user edits their profile via Workspace Settings, the cultural map is **silently dropped** on save. |
| **WorkspaceSettings.tsx** | Only renders flat string arrays. No UI for viewing or editing the structured cultural map. |
| **styleIntelligence.ts** | `computeBaseStyleProfile()` reads summary, targetAudience, designStyles, crossNicheCategories, etsyKeywords, avoidTopics. It **never reads culturalMap**. |
| **nicheHunter.ts (deconstructAndAdapt)** | This is the ONE place that actually reads `culturalMap` and passes it into the LLM prompt. But the prompt says "cultural map is for VOCABULARY and CONTEXT only — NEVER inject new visual elements from it" — which means the mascot-swap intelligence (bigfoot→llama) is explicitly disabled. |

### Net Effect

The cultural map is:
1. Generated (correctly) at onboarding
2. Stored in DB (correctly)
3. **Never shown** to the user for review/editing
4. **Silently destroyed** if the user updates their profile
5. **Partially used** in one place (deconstructAndAdapt) but with constraints that disable its primary value (mascot mapping)
6. **Completely ignored** by the style intelligence system

---

## 5. Complete Issue History

Below is every bug, failure, and issue encountered during the 2-day+ development of this system, extracted from `todo.md`:

### Infrastructure/Pipeline Issues (Recurring)

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Pipeline stuck 5+ hours | 150 image gen calls with no timeout | Added per-stage timeouts, capped to 10 concepts |
| Stage 6 image gen 0 images | Cloud Run kills idle instance during sequential gen | Parallelized with Promise.allSettled |
| Stage 4 hanging 10+ min | 18 sequential LLM calls across 3 stages | Parallelized all stages |
| Run #150006 — 0 images | 60s blocking wait caused Cloud Run timeout | Fire-and-forget async |
| Run #150007 — 0 books | booksProcessed not persisted before Stage 6 | Write count immediately after insert |
| Run #180001 — 0 images | Scoring LLM timeout (60s too short for 30 concepts) | Increased to 120s |
| 4/5 forum scrapers failing | Reddit blocked, Open Library TLS EOF | Rewrote all to LLM-based analysis |
| Etsy API 403 | Key format wrong (needs key:secret) | Combined ETSY_API_KEY + ETSY_API_SECRET |

### Data Integrity Issues

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Concepts/images disappearing | Each run creates NEW book row (same ISBN, different ID) | Consolidated to one row per ISBN |
| 105 book rows → 18 unique ISBNs | No upsert logic, INSERT on every run | Added upsertBooksByIsbn |
| Concept Library 0 concepts | Count query missing workspace join | Added botRuns join |
| Cross-workspace data leak | ID-based pages didn't verify workspace ownership | Added workspace verification |

### UX/UI Issues

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Blank portal on load | WorkspaceContext race condition | Added `initialized` state flag |
| Lightbox "THE IDEA" panel empty | Props not passed to ImageLightbox | Added full detail prop |
| Concept Library lightbox empty | Image URL not loading | Fixed prop wiring |
| Research tab crash | JSON.parse on already-parsed object | Added safe parseForumSignals() |
| Book names not clickable | No Link component wrapping titles | Added links throughout |
| Niche Hunter dismissed patterns reappearing | Query invalidation re-fetched all | Client-side filter |

### Niche Hunter Specific Issues

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Non-best-seller sources | No minimum favorites filter | Added MIN_FAVORITES = 500 |
| Wrong niche swap (bowling→soccer) | Prompt didn't constrain target niche | Added HARD CONSTRAINT block |
| DTF spinner on all items | No time window on "in progress" state | 5-min window after approval |
| Customizable products pulled | No title keyword filter | Added 14-term TITLE_BLOCKLIST |
| Injected animals (cats on pilates) | Cultural map mascots injected | Added NO ELEMENT INJECTION constraint |
| Copied signature | No prohibition on watermarks | Added REMOVE signature rule |
| Full-pattern shirts (Hawaiian polo) | No product type filter | Added polo/hawaiian/sublimation blocklist |
| Generic sayings ("find your zen") | No vocabulary specificity requirement | Added PICKLEBALL-SPECIFIC VOCABULARY constraint |
| Injected text ("pickleball is my therapy") | No text injection prohibition | Added NO TEXT INJECTION constraint |
| Approve pattern INSERT error | varchar(100) too small for long strings | Expanded to varchar(512) |
| Duplicate concepts across scans | No cross-scan deduplication | Added existingSourceTitles/existingPatternNames sets |
| Mockup "picture-on-picture" | AI image already shows design on shirt | Added AI extraction step |
| Design not filling print zone | 90%/85% fill ratio shrinkage | Removed shrinkage, 100% contain fit |
| White background artifacts | Near-white pixels same as design elements | AI extraction + flood-fill at generation time |

### Total Bug Count: **35+ distinct issues** over the development period

---

## 6. The 9 Latest Pipeline Failures

These were reported by the PO on 2026-06-01 after running a scan on the live system:

| # | What Happened | Source URL | Root Cause |
|---|--------------|-----------|-----------|
| 1 | Non-best-seller tennis shirt pulled | etsy.com/listing/1238977454 | Listing had < 500 favorites but passed `is_best_seller` flag |
| 2 | Bowling adapted to soccer (not pickleball) | — | LLM prompt had no explicit target niche constraint |
| 3 | DTF spinner on unapproved items | — | No time window on "in progress" state |
| 4 | Custom golf shirt pulled | etsy.com/listing/4469238276 | No title keyword filter for "customised" |
| 5 | Pilates design got "Cats" added | — | Cultural map `animalMascots` injected into adaptation |
| 6 | Punk tennis shirt signature copied | etsy.com/listing/4297400231 | No prohibition on copying watermarks/signatures |
| 7 | Full-pattern Hawaiian polo pulled | etsy.com/listing/1222328986 | No product type filter for polo/hawaiian |
| 8 | "Find your Zen on the COURT" | — | Generic sports phrase, not pickleball-specific |
| 9 | Fishing shirt got "pickleball is my therapy" | etsy.com/listing/4513725804 | LLM added text that wasn't in the source design |

**Fixes applied:** All 9 issues have code fixes deployed (filters + prompt constraints). However, these are **band-aid fixes on a fundamentally probabilistic system**. The LLM can still violate any of these constraints — they are instructions, not deterministic code.

---

## 7. Structural Architectural Deficiencies

### Deficiency 1: Probabilistic Pipeline with No Deterministic Validation

The scan pipeline chains **4 sequential LLM calls** (Reddit signals → deconstruct → adapt → rank) plus 1 image generation call. Each step is probabilistic. There is **no programmatic validation** between steps.

**Compound reliability estimate:**
- If each LLM step is 80% correct: 0.8^4 = **41% end-to-end reliability**
- If each step is 90% correct: 0.9^4 = **65% end-to-end reliability**

The only quality gate is **human review** at the end. There is no automated check that:
- The adapted concept actually relates to pickleball
- The element count matches the source
- The text presence matches the source
- The vocabulary is pickleball-specific

### Deficiency 2: Fictional Data Sources

| Data Source | Claimed | Actual |
|-------------|---------|--------|
| Etsy hot sellers | Real API data | Real when API key works; **fictional LLM data** when it doesn't |
| Reddit signals | Community scraping | **LLM hallucination** — no Reddit API call exists |
| Forum scrapers (v6) | Reddit, Goodreads, StoryGraph, Fable, Book Riot | **All 5 are LLM-based analysis** — no real scraping |
| Estimated sales | Etsy data | `Math.max(1, Math.round(favorites / 3))` — a rough heuristic |

### Deficiency 3: Deep Cultural Map is a Phantom Feature

As documented in Section 4:
- Generated but not shown to user
- Silently dropped on profile update
- Ignored by style intelligence
- Partially used in one place with constraints that disable its primary value

### Deficiency 4: No Real-Time Market Validation

The system has no way to verify that:
- A "best seller" is still selling well today
- The adapted concept doesn't already exist on Etsy (saturation check)
- The target niche audience actually wants this type of design
- The generated image matches the intended adaptation

### Deficiency 5: Single-Tenant Hardcoding

The prompt in `deconstructAndAdapt` says: "The ONLY target niche is PICKLEBALL." This is hardcoded in the system prompt. If a user creates a workspace for a different niche (hiking, fishing, etc.), the constraint block will still say "PICKLEBALL."

**Wait — actually:** Looking more carefully, the prompt reads `nicheProfile.summary` for the target niche. The "PICKLEBALL" hardcoding is in the HARD CONSTRAINT block added as a fix for issue #2. This means **the fix for issue #2 broke multi-niche support**. Any non-pickleball workspace will now have the LLM told to adapt everything to pickleball regardless of the actual workspace niche.

### Deficiency 6: Image Generation Has No Quality Gate

After generating an image, there is no automated check that:
- The image actually depicts pickleball (not the source niche)
- The layout matches the source
- Text in the image is readable and correct
- The image is suitable for DTF printing

The only check is human review of the pattern card.

### Deficiency 7: Style Extraction → Generation Disconnect

The style extraction produces a 20-field JSON. The `edit_source` prompt uses only 9 of those fields (technique, lineWeight, shadingMethod, textureDetail, inkColors, composition, framingDevice, textStyle, designEra). The other 11 fields (inkColorNames, shirtColorRole, subject, subjectCrop, scaleCoverage, textPresence, mood, humorMechanism, printMethod, garmentStyle, backgroundTreatment) are extracted but never used in generation.

---

## 8. What Actually Works

| Component | Assessment |
|-----------|-----------|
| Etsy API integration | Works correctly when key is valid. Fetches real listings with images. |
| Vision LLM style extraction | Produces reasonable style descriptions from product photos |
| Three-mode generation | Correct mode selection logic. edit_source produces best results. |
| Deduplication | Cross-scan dedup prevents repeated patterns across runs |
| Transfer validation | Patterns marked `transferValid: false` are auto-dismissed |
| Human review workflow | Approve/dismiss with signal tags works correctly |
| Post-approval pipeline | Library → Design Studio → Mockups → Shopify is fully wired |
| Source quality filters | MIN_FAVORITES + TITLE_BLOCKLIST catch obvious bad sources |
| Workspace isolation | Verified — can't access other workspace's data |

---

## 9. Premises That May Be Wrong

| Premise | Risk |
|---------|------|
| "Proven patterns in other niches transfer to pickleball" | Maybe. But the transfer requires cultural intelligence the system doesn't reliably have. |
| "An LLM can reliably perform 1:1 subject swaps" | Demonstrably unreliable — 9 failures in one scan run. |
| "Image generation can edit a source image while preserving layout" | Current AI image editors don't support pixel-level layout preservation. |
| "500+ favorites = best seller" | Etsy favorites ≠ sales. A listing can have 5000 favorites and 10 sales. |
| "Reddit community signals improve adaptation quality" | The signals are hallucinated, so they may add noise rather than signal. |
| "A single LLM prompt with constraints can enforce complex rules" | LLMs routinely ignore constraints, especially when they conflict with the creative task. |
| "The cultural map makes adaptations more authentic" | The map is generated by the same LLM that does the adaptation — it's circular reasoning. |

---

## 10. File Map

### Core Pipeline Files

| File | Lines | Purpose |
|------|-------|---------|
| `server/nicheHunter.ts` | 841 | Main scan engine (5 steps + 3-mode generation) |
| `server/styleExtractor.ts` | 119 | Vision LLM style extraction |
| `server/nicheHunterRouter.ts` | 231 | tRPC procedures (triggerScan, approve, dismiss, etc.) |
| `server/nicheHunterDb.ts` | 187 | Database helpers for scan runs + trend patterns |
| `server/onboardingRouter.ts` | 343 | Workspace creation + enrichNiche LLM |
| `server/workspaceRouter.ts` | 199 | Workspace CRUD (missing culturalMap in update schema) |
| `server/styleIntelligence.ts` | 201 | Style profile computation (ignores culturalMap) |
| `server/pipeline.ts` | 2,425 | NYT pipeline + niche ingest (separate from nicheHunter) |
| `server/forumScraper.ts` | 498 | "Forum scraping" (all 5 sources are LLM-based) |

### Frontend Files

| File | Lines | Purpose |
|------|-------|---------|
| `client/src/pages/NicheHunter.tsx` | 940 | Scan UI, pattern cards, approve/dismiss |
| `client/src/pages/OnboardingWizard.tsx` | 426 | 4-step workspace creation wizard |
| `client/src/pages/WorkspaceSettings.tsx` | ~300 | Profile editing (no cultural map UI) |

### Schema

| File | Key Tables |
|------|-----------|
| `drizzle/schema.ts` | workspaces, niche_scan_runs, trend_patterns, design_concepts, mockup_renders, shopify_listings |

---

## 11. Recommendations for Reviewer

### Questions to Ask

1. **Is the core premise sound?** Can cross-niche pattern transfer work at all, or is it fundamentally a human-judgment task that can't be automated with current LLMs?

2. **Should the cultural map be the foundation or a nice-to-have?** If it's foundational, it needs to be surfaced in the UI, editable, and wired into every downstream step. If it's a nice-to-have, remove it.

3. **Is prompt engineering the right approach for constraint enforcement?** The 9 failures show that adding more constraints to a single prompt doesn't guarantee compliance. Should there be a deterministic validation step between LLM calls?

4. **Should the system use real data or is LLM simulation acceptable?** Reddit signals are hallucinated. Forum scrapers are LLM-based. If the Etsy API fails, sources are fictional. Is this acceptable for a production tool?

5. **Is the "edit source image" approach viable?** Current image generation models can't reliably perform pixel-level layout-preserving edits. Should the system instead generate from scratch with style constraints?

6. **What's the acceptable failure rate?** If 4/8 patterns per scan are unusable, is that acceptable with human review? Or does the system need to be 7/8 correct to justify its existence?

### What to Audit

- Run a scan yourself and evaluate every pattern against the source
- Check if the cultural map is actually stored in the DB for the pickleball workspace
- Verify the "PICKLEBALL" hardcoding in the constraint block — does it break other niches?
- Test the LLM fallback path (remove Etsy API key) and evaluate fictional source quality
- Compare `edit_source` vs `style_reference` vs `prompt_only` output quality

---

## 12. Verdict

**The system is architecturally sound in its post-scan workflow** (Library → Design Studio → Mockups → Shopify). That pipeline is deterministic, well-tested, and works correctly.

**The scan engine (the part that matters most) is fundamentally probabilistic** and relies on LLM compliance with complex multi-constraint prompts. After 35+ bugs and 9 systemic failures in a single scan run, the evidence shows that:

1. **Source quality** is now gated (MIN_FAVORITES + TITLE_BLOCKLIST) — this is a real improvement
2. **Concept adaptation** remains unreliable — the LLM routinely violates constraints
3. **The cultural map** (the feature that would make adaptations intelligent) is generated but not wired end-to-end
4. **Data sources** are partially fictional (Reddit, forum scrapers, LLM fallback Etsy)
5. **There is no automated quality gate** between generation and human review

**Bottom line:** The system produces ~50% usable output per scan. The other ~50% requires human dismissal. Whether this is acceptable depends on whether the time saved by the 50% that works justifies the time spent reviewing and dismissing the 50% that doesn't.

---

*End of adversarial review brief.*
