# Niche Hunter Pipeline Audit — Root Cause Analysis

**Date:** 2026-06-01  
**Trigger:** PO scan review revealed 9 systemic failures in the latest Niche Hunter scan output  
**Scope:** `server/nicheHunter.ts` — all 5 steps of the scan pipeline

---

## Executive Summary

The Style-Faithful Pipeline implementation is architecturally sound (148 tests passing, 0 TypeScript errors), but the **LLM prompt constraints are too weak** and the **Etsy source filtering is insufficient**. The failures cluster into three root categories:

| Category | Failures | Root Cause |
|----------|----------|------------|
| **Source Quality** | #1, #4, #7 | Etsy API `is_best_seller` flag is category-relative; no title-based product-type filtering |
| **Concept Drift** | #2, #5, #8, #9 | `deconstructAndAdapt` prompt lacks hard constraints on niche target, text injection, and element injection |
| **Edit Fidelity** | #6, #9 | `buildGenerationPayload` edit_source prompt allows text addition and doesn't handle signatures |

---

## Failure #1 — Non-Best-Seller Sources

**Symptom:** Tennis shirt with ~1 sale/month pulled as a "hot seller."

**Root Cause:** The Etsy API `is_best_seller=true` flag is **relative to the listing's own category**, not an absolute volume threshold. A shirt can be "best seller" in a category with 3 total listings. The code at line 100 trusts this flag without validating actual volume.

**Fix:** After fetching listings, filter by `num_favorers >= 500`. The `favorites` variable is already extracted at line 127 but never used as a gate. Add: `if (favorites < 500) continue;`

---

## Failure #2 — Wrong Niche Swap (Bowling → Soccer)

**Symptom:** A bowling design was adapted to soccer instead of pickleball.

**Root Cause:** The `deconstructAndAdapt` system prompt (line 372) says "adapt for the target niche" but the LLM sometimes generates adaptations for arbitrary sports. The prompt provides the target niche in the user message (`TARGET NICHE: ...`) but lacks a **hard constraint** that says "ALWAYS adapt to PICKLEBALL — never to another sport."

**Fix:** Add an explicit hard rule in the system prompt: "The ONLY target niche is PICKLEBALL. Every adaptedConcept MUST be about pickleball. NEVER adapt to another sport (soccer, basketball, etc.)."

---

## Failure #3 — DTF Spinner on Unapproved Items

**Symptom:** DTF "in progress" spinner shows on patterns that were never approved.

**Root Cause:** The 5-minute window fix was deployed to the local dev server (checkpoint b30c7fbc) but the production site at `nytdesignbot-2uiwq4um.manus.space` runs the previous published version. This is a deployment propagation issue, not a code bug.

**Fix:** Verify the fix is working on local dev. The production fix requires the user to re-publish. No code change needed.

---

## Failure #4 — Customizable Products Not Filtered

**Symptom:** A "customized golf shirt" was pulled and adapted to a "custom pickleball shirt."

**Root Cause:** The Etsy search at line 94-155 has no title-based filtering. Listings with "custom", "personalized", "customized" in the title are print-on-demand products that allow buyer customization — these are NOT transferable design patterns because the design is unique per order.

**Fix:** After extracting the title (line 121), check against a blocklist: `["custom", "personalized", "customized", "personalised", "made to order", "your name", "your text"]`. Skip the listing if any match.

---

## Failure #5 — Injected Animals (Pilates → Cats)

**Symptom:** A pilates design (no animals) got "Cats" added to the adaptation.

**Root Cause:** The `deconstructAndAdapt` prompt provides the cultural map which includes `animalMascots` (line 350-352). The LLM sees "cats work for pickleball" in the cultural context and injects cats into designs that had NO animals in the source. The prompt lacks a constraint: "DO NOT add elements that weren't in the source design."

**Fix:** Add hard rule: "The adaptedConcept must contain ONLY elements present in the source design. If the source has no animals, the adaptation must have no animals. If the source has no text, the adaptation must have no text. The cultural map is for VOCABULARY and CONTEXT only — not for injecting new visual elements."

---

## Failure #6 — Copied Signature

**Symptom:** A punk grunge tennis shirt had a bottom signature that was copied verbatim instead of being adapted.

**Root Cause:** The `buildGenerationPayload` edit_source prompt (line 508-519) says "KEEP the EXACT same layout" and "ONLY change the SUBJECT/ACTIVITY depicted." A bottom signature/watermark is neither a subject nor an activity — it falls through the cracks. The LLM interprets "keep everything else" as "keep the signature too."

**Fix:** Add to the edit_source prompt: "If the source has a signature, watermark, or artist mark at the bottom, REMOVE it entirely. Do not copy or adapt it."

---

## Failure #7 — Full-Pattern Shirts (Hawaiian Polo)

**Symptom:** A full-pattern Hawaiian golf polo was adapted as a full-pattern pickleball shirt.

**Root Cause:** The Etsy search query includes "graphic shirt" (line 98) but this doesn't exclude polo shirts, performance wear, or all-over-print/sublimation shirts. These product types are fundamentally different from graphic tees — they can't be adapted with a simple subject swap because the "design" IS the entire garment.

**Fix:** Add title-based filtering to exclude: `["polo", "performance", "hawaiian", "sublimation", "all over print", "allover", "full print", "jersey", "dri-fit", "moisture wicking"]`. Only accept listings that appear to be standard graphic t-shirts.

---

## Failure #8 — Non-Pickleball Sayings

**Symptom:** "Find your Zen on the COURT" — generic sports phrase, not pickleball-specific.

**Root Cause:** The `deconstructAndAdapt` prompt says to use "community signals" and "cultural map" but doesn't enforce that adapted text MUST use pickleball-specific vocabulary. The LLM defaults to generic sports language ("court", "game", "play") instead of pickleball terms ("dink", "kitchen", "third shot drop", "paddle").

**Fix:** Add hard rule: "All text in adaptedConcept MUST use pickleball-specific vocabulary. Use terms like: dink, kitchen, third shot drop, paddle, volley, erne, ATP, stacking, skinny singles, rally, NVZ, drop shot. NEVER use generic sports phrases like 'find your zen on the court' or 'game day' — these could apply to ANY sport."

---

## Failure #9 — Injected Niche Text

**Symptom:** A fishing shirt design got "pickleball is my therapy" text added that wasn't in the original.

**Root Cause:** Two compounding issues:
1. The `deconstructAndAdapt` prompt allows the LLM to generate adaptedConcepts that ADD text not present in the source.
2. The `buildGenerationPayload` edit_source prompt (line 508-519) says "ONLY change the SUBJECT/ACTIVITY" but doesn't explicitly say "DO NOT ADD text that wasn't in the original."

**Fix:** 
- In `deconstructAndAdapt`: "If the source design has NO text/slogan, the adaptedConcept must describe a design with NO text/slogan. Do NOT invent slogans."
- In `buildGenerationPayload` edit_source: "DO NOT add any text, words, or slogans that were not present in the original design. If the source has no text, the output must have no text."

---

## Implementation Plan

All fixes are **surgical** — they modify existing functions without changing architecture:

| Fix | File | Function | Change Type |
|-----|------|----------|-------------|
| #1 | nicheHunter.ts | fetchCrossNicheHotSellers | Add `favorites < 500` gate after line 127 |
| #2 | nicheHunter.ts | deconstructAndAdapt | Add hard rule to system prompt |
| #4 | nicheHunter.ts | fetchCrossNicheHotSellers | Add title blocklist filter after line 121 |
| #5 | nicheHunter.ts | deconstructAndAdapt | Add "no injection" hard rule to system prompt |
| #6 | nicheHunter.ts | buildGenerationPayload | Add signature removal rule to edit_source prompt |
| #7 | nicheHunter.ts | fetchCrossNicheHotSellers | Add product-type blocklist filter |
| #8 | nicheHunter.ts | deconstructAndAdapt | Add pickleball vocabulary enforcement rule |
| #9 | nicheHunter.ts | deconstructAndAdapt + buildGenerationPayload | Add "no text injection" rules |

**Estimated lines changed:** ~60 lines added/modified in a single file.
