# Root Cause Analysis — Two Critical Niche Hunter Failures

## Karpathy Principle 1: Think Before Coding

### Failure 1: Etsy search pulls low-selling pickleball shirts

**Root cause identified (line 84-86 of nicheHunter.ts):**
```ts
const crossCategories = crossNicheCategories.slice(0, 4);
const nicheKeywords = (etsyKeywords ?? []).slice(0, 4);
const categories = [...crossCategories, ...nicheKeywords].slice(0, 8);
```

The function combines `crossNicheCategories` (e.g., "hiking shirts", "camping shirts") with
`etsyKeywords` (e.g., "pickleball shirt", "dink pickleball shirt") into a single list.
Both are searched with `is_best_seller=true`, but:

1. The `etsyKeywords` are niche-specific (pickleball terms) — this finds pickleball shirts that
   happen to be "best sellers" in their tiny niche (1 sale/mo with "best seller" badge).
2. Etsy's `is_best_seller=true` API flag marks listings that have the "best seller" badge —
   which is RELATIVE to their category, not absolute volume. A "Heavy Dinker" shirt with
   1 sale/mo can be a "best seller" in the tiny "pickleball shirt" category.

**The fix:** Remove `etsyKeywords` from the Etsy search entirely. The scan should ONLY search
cross-niche categories (hiking, camping, yoga, fishing, reading, etc.) — never the user's
own niche. The whole point is to find proven designs in OTHER markets and transport them.

### Failure 2: edit_source mode changes the entire concept

**Root cause identified (line 494-497 of nicheHunter.ts):**
```ts
const prompt = `Replace the subject of this t-shirt design with: ${baseSubject}. ` +
  `Keep EXACTLY the same visual style: ${styleDesc}. ` +
  `Preserve the composition format (${composition}). ` +
  `Transparent background, print-ready DTF/screen-print art, no shirt visible.`;
```

The prompt says "Replace the subject" and "Keep the same visual style" — but it does NOT
explicitly say "Keep the EXACT SAME LAYOUT, positions, number of elements, text placement."

The cat yoga shirt has: 5 cats in yoga poses (grid layout), title text "Yoga Master" at top,
subtitle text "Still working on teaching my toes" at bottom. The adaptation should be:
5 cats in PICKLEBALL poses (same grid), title "Pickleball Master" at top, subtitle adapted.

Instead the AI generated a completely different composition because:
- `baseSubject` (adaptedConcept) says something like "I'd Rather Be Dinking" — a totally new concept
- The prompt doesn't enforce "same number of elements, same grid, same text positions"
- The LLM in deconstructAndAdapt() is generating a NEW concept instead of a 1:1 subject swap

**The fix:** The edit_source prompt must be MUCH more explicit:
- "Keep the EXACT same number of visual elements in the EXACT same positions"
- "Keep the EXACT same text layout (title position, subtitle position)"
- "ONLY change the subject/activity depicted — nothing else"
- The adaptedConcept for edit_source mode should describe a 1:1 swap, not a new concept

## Success Criteria

1. After fix: scan produces 0 patterns from pickleball-specific Etsy searches
2. After fix: all source listings come from OTHER niches (hiking, camping, yoga, fishing, etc.)
3. After fix: all source listings have meaningful sales volume (>50 sales/mo estimated)
4. After fix: edit_source images preserve the EXACT layout of the source (same grid, same positions)
5. After fix: the cat yoga shirt → should produce cats in pickleball poses in same grid layout

## Plan (per Karpathy Principle 4: Goal-Driven Execution)

1. Remove `etsyKeywords` from the Etsy search categories list → verify: only cross-niche terms searched
2. Rewrite edit_source prompt to enforce exact layout preservation → verify: prompt text is explicit
3. Run live scan → verify: sources are all cross-niche, high-volume; images preserve layout
