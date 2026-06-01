# NYT Design Bot — Niche Hunter System: Full Architectural Audit for Adversarial Review

**Prepared for:** External adversarial reviewer  
**Date:** June 1, 2026  
**System:** NYT Design Bot — Niche Hunter subsystem  
**Stack:** React 19 + Tailwind 4 + Express 4 + tRPC 11 + Drizzle ORM + MySQL/TiDB  
**Production URL:** nytdesignbot-2uiwq4um.manus.space  
**Repository:** simpliolabs/NY-Best-Seller-research

---

## 1. System Purpose and Business Premise

The Niche Hunter is a **cross-niche design research and generation engine** for print-on-demand t-shirts, currently targeting the pickleball market. Its core thesis is:

> Find proven best-selling graphic t-shirt designs from OTHER niches (hiking, fishing, yoga, camping, etc.), extract the transferable visual pattern, and adapt that pattern to pickleball — preserving the exact art style, composition, and emotional hook while only swapping the depicted activity/subject.

The system is NOT a generic AI image generator. It is a **style-faithful transfer engine** that should produce output indistinguishable from "what if that same Etsy seller made a pickleball version." The value proposition is: proven designs from high-volume sellers, adapted with surgical precision, ready for DTF printing.

---

## 2. System Architecture Overview

### 2.1 Data Model

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `workspaces` | Multi-tenant container; one per niche | `nicheProfile` (JSON), `styleProfile` (JSON), `styleOverride` (JSON) |
| `niche_scan_runs` | One row per triggered scan | `status`, `progress`, `patternsFound` |
| `trend_patterns` | One row per discovered design pattern | `sourceImageUrl`, `sourceStyleJson`, `adaptationMode`, `adaptedConcept`, `previewImageUrl`, `dtfImageUrl`, `status` (discovered/approved/dismissed), `approvalTags`, `rejectionTags` |
| `product_groups` | Blank mockup templates (shirt colors) | `printZone` (JSON: x/y/width/height) |
| `mockup_renders` | Composited design-on-shirt images | `compositeUrl` |

### 2.2 Pipeline Steps (per scan)

```
Step 1:   Fetch Etsy hot sellers from cross-niche categories (real API or LLM fallback)
Step 1b:  Vision LLM style extraction per source image → SourceStyleJSON (20 fields)
Step 2:   Reddit signal extraction (LLM simulates subreddit analysis)
Step 3+4: Deconstruct source patterns + adapt to target niche (LLM, cultural-map-aware)
Step 5:   Three-mode image generation (edit_source / style_reference / prompt_only)
Step 6:   Rank all patterns by commercial potential (LLM scoring 0-100)
```

### 2.3 Post-Scan Workflow

```
User reviews patterns → Approve (with tags + reason) or Dismiss (with tags + reason)
  → Approved patterns trigger deferred DTF extraction (background removal → S3 upload)
  → Signal weights computed from all approval/rejection tags → Style Preferences card
  → Approved designs can be composited onto mockup templates via the Mockups page
```

---

## 3. The Niche Profile: What Exists vs. What's Exposed

### 3.1 Backend Schema (what the LLM generates at onboarding)

The `enrichNiche` mutation in `server/onboardingRouter.ts` asks the LLM to produce a **Deep Cultural Map** with 9 structured categories:

| Category | Schema | Purpose |
|----------|--------|---------|
| `animalMascots` | `[{ animal, whyItWorks, visualTreatment }]` | Which animals resonate with this niche and why |
| `painPoints` | `[{ pain, humorAngle }]` | Frustrations that drive humor-based purchases |
| `funPoints` | `[{ joy, visualConcept }]` | Joyful moments with visual design potential |
| `insideJokes` | `[{ joke, context }]` | Insider references only community members understand |
| `physicalComedy` | `[{ scenario, whyFunny }]` | Funny physical scenarios specific to the activity |
| `catchphrases` | `string[]` | Real phrases the community uses |
| `lifestyleIdentity` | `[{ trait, purchaseDriver }]` | Identity signaling that drives apparel purchases |
| `rivalries` | `[{ rivalry, tension, humorAngle }]` | Us-vs-them dynamics |
| `transferableVisualConcepts` | `[{ sourceNiche, sourcePattern, targetAdaptation, whyItTransfers }]` | Explicit cross-niche mapping formulas |

The LLM prompt is well-structured (lines 109-138 of `onboardingRouter.ts`) and requests 3-10 items per category. The Zod validation schema enforces the structure. The `finalizeWorkspace` mutation stores this on the workspace's `nicheProfile` JSON column.

### 3.2 Frontend Display (what the user actually sees — THE CRITICAL GAP)

**The Onboarding Wizard (Step 3 "Review AI Profile") does NOT display the Deep Cultural Map.**

The wizard at `client/src/pages/OnboardingWizard.tsx` lines 286-326 renders ONLY these flat array fields:

```typescript
[
  { key: "subreddits", label: "Subreddits to Scan" },
  { key: "etsyKeywords", label: "Etsy In-Niche Keywords" },
  { key: "crossNicheCategories", label: "Cross-Niche Scan Categories" },
  { key: "culturalMoments", label: "Cultural Moments / Inside Jokes" },  // ← LEGACY flat array
  { key: "designStyles", label: "Design Styles" },
  { key: "avoidTopics", label: "Avoid Topics" },
]
```

**There is NO UI for viewing or editing:**
- `culturalMap.animalMascots`
- `culturalMap.painPoints`
- `culturalMap.funPoints`
- `culturalMap.insideJokes`
- `culturalMap.physicalComedy`
- `culturalMap.catchphrases`
- `culturalMap.lifestyleIdentity`
- `culturalMap.rivalries`
- `culturalMap.transferableVisualConcepts`

### 3.3 Workspace Settings (post-creation editing)

The `WorkspaceSettings.tsx` page also uses only flat array helpers (`updateProfileArray/removeProfileItem/addProfileItem`). There is no nested-object editor for the cultural map categories.

### 3.4 Workspace Update Router (backend contract)

The `workspace.update` mutation in `server/workspaceRouter.ts` (lines 52-94) uses the **OLD shallow Zod schema** that does NOT include `culturalMap`. This means:

- Even if the cultural map is generated at onboarding and stored in the DB, any subsequent workspace update will **silently drop it** because the validation schema doesn't accept it.
- The round-trip is broken: create → store deep map → edit settings → save → deep map gone.

### 3.5 Summary of the Gap

```
LLM generates Deep Cultural Map ✓ (backend, onboarding)
Stored in DB                     ✓ (JSON column, no validation on read)
Displayed to user                ✗ (wizard shows only flat arrays)
Editable by user                 ✗ (no nested-object UI exists)
Preserved on workspace update    ✗ (router schema rejects it)
Used by style intelligence       ✗ (computeBaseStyleProfile ignores it)
Used by Niche Hunter scan        ~ (partially — deconstructAndAdapt reads it, but only if it survived storage)
```

---

## 4. The Scan Engine: How It Works and Where It Fails

### 4.1 Source Acquisition (`fetchCrossNicheHotSellers`)

**What it does:** Searches Etsy API with cross-niche category terms (e.g., "hiking graphic shirt", "yoga tee graphic") using `is_best_seller=true` flag and `sort_on=score`.

**Current filters (as of latest checkpoint b7232258):**
- `MIN_FAVORITES = 500` — rejects listings with fewer than 500 favorites
- `TITLE_BLOCKLIST` — 14 terms: custom, personalized, polo, hawaiian, sublimation, etc.
- Max 2 listings per category, max 8 categories

**Known remaining weaknesses:**
- The `is_best_seller` flag is still used but is category-relative (Etsy's definition, not ours)
- No image-based filtering — a listing could pass title filters but still be a full-pattern sublimation shirt if the title doesn't mention it
- No price-range filtering — very cheap listings ($5-8) are often low-quality clip-art designs
- The LLM fallback path (when Etsy API key is invalid) generates fictional listings with no real source images, making style extraction impossible

### 4.2 Style Extraction (`extractStyleFromImage`)

**What it does:** Sends source Etsy product image to Vision LLM with a structured JSON schema requesting 20 style fields (technique, lineWeight, shadingMethod, inkColors, composition, textPresence, mood, etc.).

**Known weaknesses:**
- The Vision LLM is analyzing a **product photo** (shirt on model/flat lay), not an isolated design. It must infer the design's style through the garment, which introduces noise.
- No confidence score — extraction either succeeds or returns null. There's no "low confidence" middle ground.
- Sequential processing (not parallel) — 8 extractions run one-by-one, adding ~30-60s to scan time.

### 4.3 Concept Adaptation (`deconstructAndAdapt`)

**What it does:** Takes all hot sellers + Reddit signals + cultural map, asks LLM to:
1. Deconstruct why each source design sells (composition, color, emotional hook)
2. Extract the transferable pattern formula
3. Adapt that formula for pickleball with a 1:1 subject swap

**Current hard constraints (as of latest checkpoint):**
- Target niche is ALWAYS pickleball
- No element injection (no adding animals/text not in source)
- No text injection (if source has no text, output has no text)
- Pickleball-specific vocabulary required for any adapted text
- Transfer validation gate (puns/hooks must work in target niche)

**Known remaining weaknesses:**
- The `adaptedConcept` field is a free-text string. There is no structured schema enforcing "source had X elements, adaptation has exactly X elements." The LLM can still drift.
- The cultural map is passed as context, which creates a temptation for the LLM to inject cultural elements even when the source doesn't have them. The hard constraints attempt to prevent this, but LLM compliance is probabilistic, not deterministic.
- No vision-based validation: the system never compares the generated image back to the source to verify style fidelity.

### 4.4 Image Generation (`buildGenerationPayload`)

**Three modes:**

| Mode | Trigger | What happens |
|------|---------|--------------|
| `edit_source` | Source image available + style extraction succeeded | Source image passed as `originalImages[0]`, prompt says "edit this, only change the activity" |
| `style_reference` | Source image available but style extraction failed | Source image passed as reference, prompt describes desired style from pattern fields |
| `prompt_only` | No source image (LLM fallback path) | Pure text prompt, no reference image |

**Known weaknesses:**
- `edit_source` mode relies on the image generation model's ability to follow "keep everything, only change X" instructions. In practice, image generation models (DALL-E, Midjourney, Flux) have limited instruction-following for edits — they tend to regenerate the entire image.
- No iterative refinement — if the first generation is wrong, there's no automatic retry with a tighter prompt.
- The `adaptedConcept` string from `deconstructAndAdapt` is used directly in the prompt. If that string contains drift (e.g., mentions cats when source had no cats), the image will faithfully render the drifted concept.

### 4.5 Ranking (`rankPatterns`)

**What it does:** LLM scores each pattern 0-100 based on market fit (40%), originality (30%), emotional resonance (30%).

**Known weaknesses:**
- The LLM has no access to actual Etsy market data for the target niche. It's guessing commercial potential based on its training data.
- No A/B testing or real-world validation loop.

---

## 5. Systemic Failures (9 documented, root-caused)

These were reported by the PO after the latest scan and have been root-caused. Fixes for all 9 are implemented in checkpoint b7232258 but have NOT been validated with a live scan yet.

| # | Failure | Root Cause | Fix Status |
|---|---------|-----------|------------|
| 1 | Tennis shirt with 1 sale/mo pulled | `is_best_seller` is category-relative; no volume gate | Fixed: MIN_FAVORITES=500 |
| 2 | Bowling → soccer (wrong niche) | LLM not constrained to pickleball target | Fixed: hard constraint added |
| 3 | DTF spinner on unapproved items | 5-min window fix not deployed to production | Fixed locally, needs publish |
| 4 | Custom golf shirt adapted | No title filtering for customizable products | Fixed: TITLE_BLOCKLIST |
| 5 | "Cats" injected into pilates design | Cultural map's animalMascots injected by LLM | Fixed: "no element injection" rule |
| 6 | Bottom signature copied verbatim | edit_source said "keep everything" including signatures | Fixed: "remove signatures" rule |
| 7 | Hawaiian polo adapted | No product-type filtering | Fixed: TITLE_BLOCKLIST |
| 8 | "Find your Zen on the COURT" | Generic sports phrase, not pickleball-specific | Fixed: vocabulary enforcement |
| 9 | "Pickleball is my therapy" injected | edit_source allowed text addition | Fixed: "no text injection" rule |

**Critical observation:** Fixes #2, #5, #8, #9 are all **LLM prompt constraints**. LLM compliance with prompt constraints is probabilistic. These fixes reduce the failure rate but cannot guarantee zero failures. The system has no post-generation validation gate.

---

## 6. Architectural Deficiencies (Structural, Not Bug-Level)

### 6.1 The Deep Cultural Map is Generated But Never Exposed

The system generates a rich 9-category cultural map at onboarding, but:
- The user never sees it (no UI rendering)
- The user can never edit it (no nested-object editor)
- It may be silently dropped on workspace update (router schema mismatch)
- The style intelligence module ignores it entirely

**Impact:** The cultural map is a phantom feature. It exists in the database but has no user-facing surface, no editing capability, and incomplete downstream consumption.

### 6.2 No Post-Generation Quality Gate

The system generates an image and stores it immediately. There is no automated check that:
- The generated image actually matches the source style
- The generated image doesn't contain injected elements
- The generated image uses the correct niche vocabulary
- The generated image preserves the source layout

**Impact:** Every quality failure reaches the user. The only gate is manual human review (approve/dismiss), which defeats the purpose of automation.

### 6.3 The Reddit Signal Step is Pure LLM Hallucination

Step 2 (`extractInNicheSignals`) does NOT actually scrape Reddit. It asks the LLM to "analyze" subreddits like r/Pickleball — but the LLM has no live access to Reddit. It generates plausible-sounding signals from its training data.

**Impact:** The "Reddit signals" are fictional. They add no real-time market intelligence. The system would produce identical signals whether Reddit existed or not.

### 6.4 LLM Fallback Path Produces Unusable Patterns

When the Etsy API key is invalid or returns too few results, the system falls back to an LLM that generates fictional "hot sellers." These fictional listings have:
- No real source image URL → style extraction returns null → mode falls to `prompt_only`
- No real sales data → cannot validate commercial viability
- No real Etsy listing → user cannot verify the source

**Impact:** The LLM fallback produces patterns with no provenance, no style reference, and no commercial validation. They are pure LLM imagination dressed up as "market research."

### 6.5 No Deduplication Across Concepts (Only Titles)

Cross-scan deduplication checks `sourceTitle` and `patternName` but not semantic similarity. Two scans could produce:
- Scan 1: "Skeleton fishing" → "Skeleton playing pickleball"
- Scan 2: "Skull with rod" → "Skull with paddle"

These are semantically identical but pass deduplication because the strings differ.

### 6.6 Sequential Processing Creates Scan Timeouts

Style extraction runs sequentially (one image at a time). With 8 sources × ~10s per extraction = ~80s just for Step 1b. Combined with LLM calls for Steps 2-6, total scan time can exceed 3 minutes, risking Cloud Run timeouts on the deployed platform.

### 6.7 The "Style-Faithful" Promise is Architecturally Unenforceable

The entire system relies on:
1. LLM correctly extracting style from a product photo (probabilistic)
2. LLM correctly generating a 1:1 subject swap concept (probabilistic)
3. Image generation model correctly following edit instructions (probabilistic)

Three probabilistic steps in series means the compound success rate is: `P(correct_extraction) × P(correct_concept) × P(correct_generation)`. Even if each step is 80% reliable, the end-to-end success rate is 51%.

**There is no deterministic enforcement anywhere in the pipeline.** The system is fundamentally a "best effort" pipeline with human review as the only quality gate.

---

## 7. What Works Well

Despite the issues above, the following architectural decisions are sound:

| Decision | Why It's Good |
|----------|---------------|
| Three-mode generation | Correctly identifies that different adaptation distances need different approaches |
| Deferred DTF extraction | Saves API calls by only processing approved patterns |
| Approval/rejection signal system | Creates a feedback loop for future improvement |
| Source style JSON (20 fields) | Comprehensive enough to describe any print-on-demand design |
| Transfer validation gate | Auto-dismisses patterns where the pun/hook doesn't survive niche transfer |
| MIN_FAVORITES filter | Ensures genuine commercial validation from source |
| Title blocklist | Prevents non-graphic products from entering the pipeline |
| Cultural map schema design | The 9-category structure is well-thought-out for cross-niche adaptation |

---

## 8. File Map (Key Source Files)

| File | Lines | Purpose |
|------|-------|---------|
| `server/nicheHunter.ts` | ~830 | Main scan engine — all 5 pipeline steps |
| `server/styleExtractor.ts` | ~100 | Vision LLM style extraction → SourceStyleJSON |
| `server/onboardingRouter.ts` | ~344 | Workspace creation wizard backend (enrichNiche + finalizeWorkspace) |
| `server/nicheHunterRouter.ts` | ~200 | tRPC router for scan trigger, pattern moderation, signals |
| `server/nicheHunterDb.ts` | ~150 | DB helpers for scans and patterns |
| `server/signalWeights.ts` | ~80 | Pure function: compute approval/rejection tag weights |
| `server/patternDtfProcessor.ts` | ~100 | Background removal + S3 upload for approved patterns |
| `server/styleIntelligence.ts` | ~200 | Style profile computation (does NOT use cultural map) |
| `server/workspaceRouter.ts` | ~150 | Workspace CRUD (update schema is SHALLOW — missing culturalMap) |
| `client/src/pages/OnboardingWizard.tsx` | ~420 | 4-step wizard UI (does NOT display cultural map) |
| `client/src/pages/NicheHunter.tsx` | ~500 | Pattern grid with approve/dismiss UI |
| `client/src/pages/WorkspaceSettings.tsx` | ~300 | Post-creation settings (no cultural map editor) |
| `drizzle/schema.ts` | ~470 | Full database schema |
| `shared/sourceStyleJson.ts` | ~50 | TypeScript interface for 20-field style JSON |

---

## 9. Test Coverage

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `server/stylePipeline.test.ts` | 25 | signalWeights (8), determineAdaptationMode (4), extractStyleFromImage (5), source filtering (6), prompt hardening (2) |
| `server/nicheHunter.test.ts` | 6 | Router-level: scan status, pattern retrieval |
| `server/pipeline.test.ts` | 20 | NYT pipeline (unrelated to Niche Hunter) |
| `server/routers.test.ts` | 19 | General tRPC procedures |
| Other test files | ~85 | Mockups, revisions, workspace, shopify, forum scraper, etc. |

**Total: 155/156 passing** (1 failure is NYT API timeout — external network issue)

**What's NOT tested:**
- End-to-end scan with real Etsy API (requires live credentials + network)
- LLM prompt compliance (cannot unit-test LLM behavior deterministically)
- Image generation quality (cannot programmatically verify visual output)
- Cultural map round-trip (generate → store → update → verify preserved)

---

## 10. Premises That May Be Wrong

| Premise | Risk |
|---------|------|
| "Etsy best-sellers from other niches transfer to pickleball" | Some visual patterns are niche-specific and don't transfer (e.g., fishing skeleton aesthetic may not resonate with pickleball's social/fun identity) |
| "LLM can reliably do 1:1 subject swaps" | Current image generation models cannot reliably edit-in-place; they tend to regenerate |
| "The cultural map will prevent bad adaptations" | The cultural map is context, not constraint. LLMs treat context as suggestion, not rule. |
| "Reddit signals add value" | They're LLM-generated fiction, not real data |
| "500 favorites = genuine best-seller" | A listing can have 500 favorites from years ago and sell 0 today |
| "Title keywords catch all bad products" | Sublimation shirts don't always say "sublimation" in the title |
| "8 patterns per scan is enough" | With filtering, many scans may produce 2-3 usable patterns after human review |

---

## 11. Recommended Actions for Reviewer

1. **Verify the cultural map round-trip**: Create a workspace, check DB for `culturalMap` presence, update workspace settings, check if map survives.

2. **Run a live scan**: Trigger a Niche Hunter scan and evaluate each output pattern against the source. Score: Does it preserve style? Does it avoid injection? Is it pickleball-specific?

3. **Test the LLM fallback path**: Disable the Etsy API key and run a scan. Evaluate whether the fictional sources produce anything useful.

4. **Audit the edit_source mode**: Find a pattern that used edit_source. Compare the source Etsy image to the generated preview. Is it actually a 1:1 swap or a complete regeneration?

5. **Check the workspace update contract**: Edit workspace settings and save. Does the cultural map survive? (Prediction: it won't, because the router schema is shallow.)

6. **Evaluate commercial viability**: Of the patterns produced in the last 5 scans, how many would a human designer actually approve for production? What's the hit rate?

---

## 12. Summary Verdict

The Niche Hunter system has a **sound architectural vision** (cross-niche style transfer with structured cultural intelligence) but suffers from **three categories of implementation gaps**:

1. **Phantom features** — The Deep Cultural Map is generated but never exposed to users, never editable, and partially consumed by downstream systems. It's a backend artifact with no user-facing surface.

2. **Probabilistic quality** — The entire pipeline relies on three sequential LLM/AI steps with no deterministic validation. The compound reliability is low, and the only quality gate is manual human review.

3. **Fictional data** — The Reddit signals are hallucinated, the LLM fallback produces fictional sources, and there's no real-time market validation beyond Etsy favorites count.

The system needs either (a) a post-generation automated quality gate that rejects bad outputs before they reach the user, or (b) acceptance that it's a "suggestion engine" requiring heavy human curation, not an automated production pipeline.

---

*End of document. Prepared for adversarial review.*
