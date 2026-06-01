# Niche Hunter — Adversarial Review Brief

**Purpose:** Hand this to another developer/AI so they can understand exactly what's broken and fix it.  
**Date:** 2026-06-01  
**Live app:** https://nytdesignbot-2uiwq4um.manus.space  
**Repo:** github.com/simpliolabs/NY-Best-Seller-research  

---

## What This System Is Supposed To Do

The owner sells print-on-demand t-shirts (pickleball niche). The system is supposed to:

1. Go to Etsy and find **proven best-selling graphic tees** in OTHER niches (hiking, fishing, yoga, camping, etc.)
2. Look at each best-seller's design and extract the **visual formula** that makes it sell (layout, style, colors, composition)
3. **Swap only the subject** to pickleball — keep everything else identical (same layout, same number of elements, same text placement, same art style)
4. Generate a preview image of the adapted design
5. Show the owner for approval/rejection
6. Approved designs → mockup on shirt → Shopify listing

**The key insight:** Don't invent designs. Find what already sells in hiking/fishing/yoga and transport the exact visual formula to pickleball. Only the subject changes.

---

## The 4 Major Problems

### PROBLEM 1: Not Actually Getting Best Sellers From Etsy

**What should happen:**  
Go to `https://www.etsy.com/search?q=hiking%20shirt&is_best_seller=true` — you can see the results right there. Bigfoot Dandelion Shirt (131 reviews), Cute Goose Camping Shirt (415 reviews), "Out Of Breath Hiking Society" (1.3k reviews), etc. These are REAL best sellers with the "Bestseller" badge.

**What actually happens in the code:**

```typescript
// server/nicheHunter.ts line 110
const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(searchQuery)}&limit=8&sort_on=score&is_best_seller=true`;
const resp = await fetch(url, {
  headers: { "x-api-key": etsyApiKey },
  signal: AbortSignal.timeout(8000),
});
```

**The issues:**

1. The Etsy API v3 `is_best_seller` filter doesn't work the same as the web UI filter. The web UI clearly shows "Bestseller" badges. The API returns listings sorted by "score" but the `is_best_seller` flag doesn't reliably filter to only badge-holders. That's why a tennis shirt with ~1 sale/month got through (Failure #1: https://www.etsy.com/listing/1238977454).

2. We added `MIN_FAVORITES = 500` as a band-aid, but that's a guess. The Etsy web search shows listings with 131 reviews that DO have the Bestseller badge. Favorites ≠ reviews ≠ sales. The heuristic `estimatedSales: Math.max(1, Math.round(favorites / 3))` is made up.

3. When the API key fails or returns < 4 results, the system falls back to asking the LLM to **invent fictional Etsy listings**. These don't exist. The "estimated sales" are made up. There are no source images. This is the `prompt_only` generation path — lowest quality.

4. Even when the API works, we only pull `limit=8` per category and take the first 2 that pass filters. We're not actually getting the TOP sellers — we're getting whatever Etsy's "score" sort returns first.

**What the Etsy web search actually shows (browsed today):**

| Listing | Reviews | Badge | Type |
|---------|---------|-------|------|
| Bigfoot Dandelion Shirt | 131 | Bestseller | Graphic tee — GOOD source |
| Cute Goose Camping Shirt | 415 | Bestseller | Graphic tee — GOOD source |
| National Parks Bear Graphic Tee | 113 | Popular now | Graphic tee — NOT bestseller |
| Comfort Colors National Park "Respect The Locals" | 23.2k | Popular now | Photo tee — NOT bestseller |
| "Out Of Breath Hiking Society" | 1.3k | Bestseller | Text design — OK source |
| Embroidered National Park T-Shirt | 18.4k | Bestseller | Personalized/embroidered — BAD source |
| Adventure Hiking Sweatshirt (True Crime) | 19.6k | Bestseller | Graphic — GOOD source |

The web search clearly distinguishes "Bestseller" from "Popular now". The API doesn't give us this distinction reliably.

---

### PROBLEM 2: The LLM Cannot Reliably Do a 1:1 Subject Swap

**What should happen:**  
Source: "Bigfoot blowing a dandelion" (hiking niche, vintage distressed style)  
Output: "Llama blowing a dandelion" (pickleball niche, same vintage distressed style, same composition, same everything except the character)

**What actually happens:**  
The LLM in `deconstructAndAdapt()` is given a massive prompt with 7 HARD CONSTRAINT blocks and told to produce a JSON `adaptedConcept` field. But it routinely:

- **Changes the entire concept** instead of doing a 1:1 swap (Failure #1: added "THIRD SHOT DROP" text that wasn't in the source)
- **Swaps to the wrong niche** (Failure #2: bowling → soccer instead of bowling → pickleball)
- **Injects new elements** (Failure #5: pilates design got "Cats" added — the design would have been perfect WITHOUT the cat word)
- **Adds text that wasn't in the source** (Failure #9: fishing shirt got "pickleball is my therapy" — source had no such text)
- **Uses generic phrases** (Failure #8: "Find your Zen on the COURT" — not pickleball-specific at all)

**The fundamental issue:** We're asking one LLM call to do 4 things simultaneously:
1. Understand the source design's visual structure
2. Identify what's transferable vs. what's niche-specific
3. Map source elements to target niche equivalents
4. Write a generation prompt that preserves layout

This is too much for a single prompt. The LLM optimizes for "creative" output, not "faithful reproduction with minimal changes." Adding more constraint blocks doesn't fix this — it just makes the prompt longer and the LLM more likely to ignore parts of it.

**The prompt is 100+ lines long** (see `server/nicheHunter.ts` lines 397-454). It has:
- Transfer validation rules
- adaptedConcept format rules
- Target niche constraint (hardcoded "PICKLEBALL")
- No element injection rules
- No text injection rules
- Pickleball-specific vocabulary rules

The LLM still violates these. 9 failures in ONE scan run.

---

### PROBLEM 3: Image Generation Cannot "Edit" a Source Image While Preserving Layout

**What should happen:**  
Take the actual Etsy product photo, keep the exact layout/style/colors, only swap the subject.

**What actually happens:**  
The `edit_source` mode sends this prompt to the image generator:

```
Edit this t-shirt design. HARD RULES — you MUST follow ALL of these:
1. KEEP the EXACT same layout — same number of visual elements in the SAME positions.
2. KEEP the EXACT same text placement — title position, subtitle position, font style.
3. KEEP the EXACT same art style: Technique: screen-print simulation. Line weight: thick bold outlines...
4. KEEP the EXACT same color palette and background treatment.
5. ONLY change the SUBJECT/ACTIVITY depicted.
6. The new subject/activity is: [adaptedConcept from the LLM]
...
```

**Editing the source image DOES preserve style pixel-to-pixel — that is the part that works.** What editing fails at is CONTENT CONTROL: because the model re-synthesizes the whole canvas without a mask, the subject swap drifts and unwanted elements/text/signatures bleed through.

Without a mask, a global edit re-renders the whole canvas, so the CONTENT drifts (style stays fine). The fix is regional/masked editing — or crop-edit-composite — plus rendering text as a separate composited layer, NOT abandoning editing. Observed content failures:

- Changes the layout entirely
- Adds elements that weren't there
- Copies signatures/watermarks from the source (Failure #6)

The `style_reference` mode is even worse — it just says "inspired by the visual style of the reference image" which gives the generator complete creative freedom.

The `prompt_only` mode (LLM fallback path) has no source image at all — it's pure text-to-image with no style constraint.

Of the three, only `edit_source` preserves style and layout reliably — its weakness is content control (subject drift, injected elements, copied signatures), which is fixable with masking + a separate text layer. `style_reference` and `prompt_only` give the generator too much freedom and should be labeled lower-quality fallbacks.

---

### PROBLEM 4: Mockup Compositor — Design Not Centered on Shirt

**What should happen:**  
The generated design should be centered on the shirt mockup, looking like a real product photo.

**What actually happens:**  
The compositor (`server/mockupCompositor.ts`) uses TOP-CENTER anchoring:

```typescript
// line 420-422
const offsetX = zoneX + Math.round((zoneW - finalW) / 2);  // Horizontally centered ✓
const offsetY = zoneY;  // TOP anchor — NOT vertically centered ✗
```

The design is pinned to the TOP of the print zone, not centered vertically. The comment says "this matches real DTF placement where designs sit at the top of the print area" — but the owner reports it still doesn't look right.

The `DEFAULT_PRINT_ZONE` is:
```typescript
{ x: 0.22, y: 0.15, width: 0.56, height: 0.60 }
```

This means the design starts at 15% from the top of the mockup image and fills a zone that's 60% of the height. With TOP anchoring, a short/wide design sits at the top of the zone with empty space below. But vertically centering inside a 0.60-tall zone would push the print toward the navel — worse. Real chest prints ARE top-anchored; the actual bug is zone geometry (~0.30–0.35 height, tuned y-origin) and/or size-based placement, not the anchor direction.

**Additional compositor issues:**
- Background removal sometimes fails (colored backgrounds, textured backgrounds)
- AI extraction (for mockup-style source images) adds its own interpretation
- The flood-fill white removal uses threshold 220 which can eat into near-white design elements

---

## The Deep Cultural Map — A Feature That Exists But Isn't Wired

During workspace onboarding, the system generates a "Deep Cultural Map" with structured data:

| Category | Example for Pickleball |
|----------|----------------------|
| animalMascots | Llama (short arms), T-Rex (can't reach lobs) |
| painPoints | Score amnesia, getting body-bagged |
| funPoints | Perfect ATP shot, kitchen battles |
| insideJokes | "The kitchen," DUPR obsession |
| rivalries | Pickleball vs tennis, bangers vs dinkers |
| catchphrases | "Dink responsibly," "Third shot drop" |
| physicalComedy | T-Rex arms, split-step dance |
| transferableVisualConcepts | Bigfoot→Llama, yoga grid→pickleball grid |

**This is the intelligence that SHOULD drive the subject swap.** When the system sees "Bigfoot blowing dandelion" it should know to map it to "Llama blowing dandelion" because the cultural map says llamas are a key pickleball mascot.

**But:**

1. **The wizard UI (Step 3) doesn't show it.** The user sees: summary, audience, subreddits, keywords, categories, cultural moments (flat strings), design styles, avoid topics. The structured cultural map is generated but INVISIBLE to the user. (See screenshot in the original message — no cultural map section.)

2. **The workspace update router drops it.** `workspaceRouter.ts` line 68-77 defines the `nicheProfile` update schema WITHOUT `culturalMap`. If the user edits their profile, the cultural map is silently deleted.

3. **The style intelligence system ignores it.** `styleIntelligence.ts` reads summary, audience, designStyles, crossNicheCategories, etsyKeywords, avoidTopics — never reads `culturalMap`.

4. **The one place that uses it (deconstructAndAdapt) explicitly disables its primary value.** The prompt says: "The cultural map is for VOCABULARY and CONTEXT only — NEVER inject new visual elements from it." This means the mascot-swap intelligence (bigfoot→llama) is explicitly forbidden.

---

## The "Reddit Signals" Are Fake

`server/nicheHunter.ts` lines 264-339 — the function `extractInNicheSignals()` claims to extract community signals from Reddit. It does NOT call the Reddit API. It sends subreddit names to the LLM and asks it to generate what it THINKS the community says:

```typescript
const response = await invokeLLM({
  messages: [
    { role: "system", content: "You are a community research expert who analyzes niche online communities..." },
    { role: "user", content: `Niche: ${nicheProfile.summary}\nCommunities: ${subreddits.join(", ")}...` }
  ]
});
```

The LLM generates "recurringPhrases", "insideJokes", "communityLanguage", "buyingTriggers" from its training data — not from live Reddit posts. These signals may be outdated, generic, or wrong.

---

## Complete List of All 9 Failures From Latest Scan

| # | Source | What Went Wrong | Why |
|---|--------|----------------|-----|
| 1 | [Tennis shirt](https://www.etsy.com/listing/1238977454) | Not a best seller, added "THIRD SHOT DROP" text, changed design completely | API `is_best_seller` flag unreliable + LLM added text not in source |
| 2 | Bowling source | Adapted to SOCCER instead of pickleball | LLM ignored target niche |
| 3 | All approved items | DTF "spin" spinner showing on items not approved for DTF | UI state bug (fixed) — already fixed and unrelated to the pipeline; exclude from the failure rate (8 real failures, not 9) |
| 4 | [Custom golf shirt](https://www.etsy.com/listing/4469238276) | Customizable product pulled, output was "Custom PICKLEBALL shirt" | No title filter for "customised" |
| 5 | Pilates source | Added "Cats" to the design — would have been PERFECT without it | Cultural map mascots injected |
| 6 | [Punk tennis shirt](https://www.etsy.com/listing/4297400231) | Copied the bottom signature/watermark from source | No prohibition on copying signatures |
| 7 | [Hawaiian golf polo](https://www.etsy.com/listing/1222328986) | Full-pattern all-over-print shirt — not a graphic tee | No product type filter |
| 8 | Generated output | "Find your Zen on the COURT" — generic, not pickleball | LLM used generic sports phrase |
| 9 | [Fishing shirt](https://www.etsy.com/listing/4513725804) | Added "pickleball is my therapy" — text NOT in source | LLM injected new text |

---

## What the Pipeline SHOULD Be (But Isn't)

### Ideal Flow:

1. **Scrape Etsy web search** (not just API) with `is_best_seller=true` filter → get listings that actually have the Bestseller badge
2. **Download the product photo** for each best seller
3. **Vision LLM extracts style** (this part works OK — `styleExtractor.ts`)
4. **Constrained subject swap (LLM + cultural map)** using the cultural map for guidance (bigfoot → llama, yoga grid → pickleball grid). This is NOT a deterministic lookup — the map holds only a handful of mascots, while real sources are arbitrary (a goose, a bear, a slogan) with no map entry. An LLM must still decide each mapping; the cultural map CONSTRAINS that decision with examples, it does not replace it.
5. **Generate image** with the source image as a strict reference + the constrained swap instructions — NOTE: style comes from the reference IMAGE, not the 20-field styleJSON; the JSON is metadata for QA/filtering, not a generation input
6. **Automated QA** — Vision LLM checks: does the output match the source layout? Is the subject actually pickleball? Is there text that shouldn't be there?
7. **Human review** of QA-passed designs only

### What's Actually Built:

1. Etsy API with unreliable `is_best_seller` flag → falls back to fictional LLM data
2. Download product photo (works when API returns image URLs)
3. Vision LLM style extraction (works)
4. **One massive LLM prompt** tries to do deconstruction + adaptation + transfer validation + concept writing all at once → fails ~50% of the time
5. Image generation with "edit" mode that can't actually preserve layout
6. **No automated QA** — goes straight to human review
7. Human reviews everything (including the ~50% garbage)

---

## File Map (What To Read)

| File | Lines | What It Does |
|------|-------|-------------|
| `server/nicheHunter.ts` | 841 | The entire scan engine — Etsy fetch, Reddit signals, deconstructAndAdapt, image generation, ranking |
| `server/styleExtractor.ts` | 119 | Vision LLM that analyzes source product photos |
| `server/mockupCompositor.ts` | 440 | Composites design onto shirt blank (centering issue lives here) |
| `server/onboardingRouter.ts` | 343 | Workspace creation + cultural map generation |
| `server/workspaceRouter.ts` | 199 | Workspace update (DROPS cultural map on save) |
| `server/styleIntelligence.ts` | 201 | Style profile computation (IGNORES cultural map) |
| `server/nicheHunterRouter.ts` | 231 | tRPC endpoints for triggering scans, approving/dismissing |
| `client/src/pages/OnboardingWizard.tsx` | 426 | Wizard UI (cultural map NOT shown at Step 3) |
| `client/src/pages/NicheHunter.tsx` | 940 | Scan results UI with pattern cards |

---

## Known Hardcoding That Breaks Multi-Niche

The fix for Failure #2 added this to the `deconstructAndAdapt` prompt:

```
=== HARD CONSTRAINT: TARGET NICHE IS PICKLEBALL (Fix #2) ===
The ONLY target niche is PICKLEBALL. Every single adaptedConcept MUST be about pickleball.
NEVER adapt to another sport (soccer, basketball, tennis, etc.).
```

This is hardcoded in the system prompt. If someone creates a workspace for hiking or fishing, the system will still force everything to pickleball.

---

## Summary For The Reviewer

**The system has 4 core problems that compound:**

1. **Source quality** — Can't reliably get actual best sellers from Etsy (API ≠ web search)
2. **Concept adaptation** — One LLM prompt tries to do too much and fails ~50% of the time
3. **Image generation** — Current AI image editors can't do "same layout, different subject"
4. **Mockup placement** — Design not centered properly on shirt

**Plus one phantom feature:**

5. **Deep Cultural Map** — Generated but invisible, dropped on update, ignored by style system, and explicitly disabled in the one place it's used

**Failure attribution:** The 80% figures are invented and the steps are a dependency chain, not independent coin flips. Failure #3 is a fixed UI bug → 8 real pipeline failures. Failures cluster: source quality (#1, #4, #7) and adaptation (#1, #2, #5, #8, #9) account for nearly all of them; image-generation content drift = 1 (#6); mockup = 0. Priority: **source ≫ adaptation > image-control ≫ mockup**.

**What needs to happen:**
- **Sourcing:** FIRST fail loud + label live vs simulated (silent fiction is the real killer — and why image gen has nothing to edit). The web "Bestseller" badge is a personalized proxy, not sales — a hint, not ground truth. Add per-scan instrumentation (HTTP status, result count, which mode fired).
- **Adaptation:** Constrain the LLM with cultural map + few-shot examples + automated vision QA. Can't be a pure lookup (long tail of arbitrary sources), but the map provides guardrails.
- **Image generation:** KEEP editing; do NOT generate from scratch (produces "way off" style). Fix control via masked/regional editing + text as a separate composited layer + a vision-QA gate that rejects content drift.
- **Mockup:** Fix the zone geometry (height ~0.30–0.35, tune y-origin to match real chest placement) or implement size-based top-pin logic — not the anchor direction.
- The cultural map needs to be surfaced in the UI, preserved on update, and actually used as the primary intelligence for subject swaps.
