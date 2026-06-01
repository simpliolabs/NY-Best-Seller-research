# Image Prompting Fix Plan — Niche Hunter Workspace

## Problem Statement

The current `IMAGE_PROMPT_SYSTEM` in `server/pipeline.ts` produces cartoonish, bright, clip-art-style designs that look like cheap AI stickers. Market-winning designs (Etsy top sellers, Sloth Hiking Club at $34.95/shirt with 25k+ customers) use a completely different aesthetic: vintage, distressed, limited-color screen-print style with hand-drawn illustration quality.

## Root Cause

The pipeline uses ONE prompt system for ALL workspace types. The existing `IMAGE_PROMPT_SYSTEM` was designed for NYT book fan merch (fictional worlds, World Bibles, illustrator styles). For niche_hunter workspaces (pickleball, hiking, etc.), it:

1. References "fictional world" and "World Bible" — meaningless for niche sports
2. Doesn't enforce the market-proven aesthetic (vintage, distressed, muted earth tones)
3. Allows the concept's `style: "Cartoonish, slightly exaggerated"` to flow unchecked into image gen
4. Doesn't limit color count (market winners use 2-4 colors; we generate 5-8)
5. Doesn't specify screen-print/DTF texture constraints that make designs look premium

## Fix Architecture

### Scope: 2 files, ~150 lines added

| File | Change | Lines |
|------|--------|-------|
| `server/pipeline.ts` | Add `NICHE_IMAGE_PROMPT_SYSTEM` constant + workspace-type branch in `stageDesignExpansion` | ~130 new lines |
| `server/pipeline.ts` | Pass `workspaceType` into `stageDesignExpansion` and select prompt system | ~5 lines changed |

### No schema changes. No new files. No frontend changes.

---

## The New Prompt System: `NICHE_IMAGE_PROMPT_SYSTEM`

### Design Philosophy (reverse-engineered from market winners):

1. **Vintage screen-print aesthetic** — NOT digital vector art
2. **2-4 color maximum** — muted earth tones, no neon/saturated
3. **Distressed/worn texture mandatory** — halftone dots, ink bleed, worn edges
4. **Hand-drawn illustration style** — imperfect lines, organic shapes
5. **Typography-forward** — text is the hero, illustration supports
6. **Badge/emblem/arch compositions** — NOT busy multi-element scenes
7. **Comfort Colors garment context** — designs that look good on washed-out fabric

### The 8-Layer Formula (replacing the 10-layer for niche):

```
[1] PRINT FORMAT + AESTHETIC ANCHOR
"Vintage screen-printed t-shirt graphic, [2-3]-color limited palette, 
hand-drawn illustration style with visible texture and grain, 
isolated on pure white background..."

[2] MARKET STYLE REFERENCE
Pull from proven market aesthetics: outdoor brand vintage (Patagonia/REI retro), 
Comfort Colors garment-dyed look, retro 70s typography, 
hand-lettered signage, vintage sports club branding.

[3] CONCEPT CORE
The central visual — described as hand-drawn, imperfect, organic.
NOT as clean digital vector. Include texture language.

[4] TYPOGRAPHY TREATMENT
Hand-lettered, retro serif, or distressed sans-serif.
Must specify: arched, stacked, or banner layout.
Letters must have texture (ink bleed, worn edges, screen-print imperfection).

[5] COLOR DECLARATION (HARD LIMIT)
Maximum 3-4 colors from this approved palette family:
- Earth tones: burnt orange, forest green, cream, brown, rust
- Muted: dusty blue, sage, mauve, terracotta, olive
- Vintage: faded gold, deep teal, burgundy, charcoal
NO bright/saturated colors. NO neon. NO gradients.

[6] TEXTURE + DISTRESS
Mandatory: halftone grain, ink bleed at edges, worn/faded areas,
screen-print registration slight offset, vintage paper texture.

[7] COMPOSITION
Badge/emblem, arch/banner, typography-stack, or small chest logo.
Must name the shape. Must have breathing room.

[8] PRINT SAFETY CLOSE
Isolated on white, DTF-ready, limited colors, no background fill.
```

---

## Wiring Change in `stageDesignExpansion`

Currently (line ~1084-1137):
```ts
const promptTasks = winners.map(async (concept): Promise<PromptSet | null> => {
  // ... builds userMsg with World Bible data ...
  const promptResult = await invokeLLM({
    messages: [
      { role: "system", content: IMAGE_PROMPT_SYSTEM },  // ← ALWAYS uses book-centric prompt
      { role: "user", content: userMsg },
    ],
  });
});
```

After fix:
```ts
const promptTasks = winners.map(async (concept): Promise<PromptSet | null> => {
  // Branch on workspace type
  const systemPrompt = workspaceType === "niche_hunter" 
    ? NICHE_IMAGE_PROMPT_SYSTEM 
    : IMAGE_PROMPT_SYSTEM;
  
  const userMsg = workspaceType === "niche_hunter"
    ? buildNicheUserMsg(concept, book)   // Niche-specific context (no World Bible)
    : buildBookUserMsg(concept, book);   // Existing book-centric context
  
  const promptResult = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
  });
});
```

---

## User Message for Niche (replacing World Bible context):

```
Design concept:
Name: ${concept.conceptName}
Source Fan Phrase: ${concept.sourcePhrase}
Humor Framework: ${concept.humorFramework}
Headline: ${concept.headline}
Subtext: ${concept.subtext}
Color Palette Suggestion: ${concept.colorPalette} (OVERRIDE with vintage earth tones if too bright)

Niche Context:
Sport/Topic: ${book.title} (this is the niche community, NOT a book)
Fan Culture: ${book.fanCulture}
Community Mood: ${book.mood}

STYLE OVERRIDE: Ignore any "cartoonish" or "bright" style suggestions from the concept. 
ALL designs must use the vintage/retro screen-print aesthetic with muted earth tones.
```

---

## Variation Definitions (Niche-Specific):

**Variation A — Clean Vintage:**
- Retro screen-print look, 2-3 colors, clean hand-drawn lines
- Light halftone texture, slight ink bleed
- Typography-forward composition

**Variation B — Heavy Distressed:**
- Same concept, maximum vintage wear
- Faded colors, heavy halftone, cracked ink effect
- Looks like a 20-year-old thrift store find

**Variation C — Alternative Layout:**
- Same phrase, different composition approach
- Could be: small chest logo, full badge, or pure typography stack
- Still vintage/retro aesthetic

---

## Hard Constraints (Non-Negotiable):

1. **ZERO bright/saturated colors** — no neon green, hot pink, bright blue
2. **MAXIMUM 4 colors** per design (including the "ink" colors only)
3. **MANDATORY texture** — no clean/smooth/digital-looking output
4. **NO cartoonish proportions** — no big heads, exaggerated expressions
5. **NO clip-art style** — no clean vector edges, no digital gradients
6. **Typography MUST be textured** — no clean digital fonts
7. **Composition MUST be named shape** — badge, arch, stack, emblem
8. **White background, DTF-ready** — same as existing constraint

---

## Expected Output Quality:

**Before (current):** Bright green pickle character with exaggerated eyes, clean vector lines, 6+ colors, looks like a kids' sticker

**After (target):** Muted forest-green and cream hand-drawn pickle paddle in a vintage badge shape, distressed halftone texture, retro serif "DINK RESPONSIBLY" arched above, looks like it was screen-printed in 1978

---

## Concept Generation Fix (Stage 4 — Secondary):

The `GENERATION_SYSTEM` prompt also needs a style override for niche_hunter workspaces. Currently it says:
> "style": "string — derived from the book's visual universe (e.g. dark academia, gothic, retro, distressed — must match the book's actual aesthetic)"

For niche_hunter, the style field should be constrained to market-proven options:
- `vintage-retro`
- `distressed-screen-print`
- `hand-drawn-outdoor`
- `retro-typography`
- `vintage-badge`

This prevents concepts from being tagged "Cartoonish, slightly exaggerated" which then poisons the image prompt.

---

## Implementation Order:

1. Add `NICHE_IMAGE_PROMPT_SYSTEM` constant (the new prompt)
2. Pass `workspaceType` to `stageDesignExpansion` function
3. Branch prompt selection based on workspace type
4. Build niche-specific user message (no World Bible)
5. (Optional, lower priority) Add style constraint to `GENERATION_SYSTEM` for niche_hunter

---

## Risk Assessment:

- **Zero risk to NYT workspace** — the existing `IMAGE_PROMPT_SYSTEM` is untouched
- **Backward compatible** — only niche_hunter workspaces get the new prompt
- **No schema changes** — all data flows remain identical
- **No frontend changes** — images display the same way regardless of how they were generated
