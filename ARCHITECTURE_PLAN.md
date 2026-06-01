# Style-Faithful Pipeline — Comprehensive Architectural Plan

**Author:** Manus AI  
**Date:** June 1, 2026  
**Status:** DRAFT — Awaiting PO Approval Before Implementation  
**Principles:** Karpathy Dev Principles (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution)

---

## Executive Summary

The current Niche Hunter pipeline has a fundamental style-fidelity problem: it finds winning Etsy designs, extracts their *concept* (composition, emotional hook, color strategy), but generates images using a single static prompt that ignores the source design's actual visual style. The result is a cartoon skeleton badge when the source was a fish-bone minimalist illustration.

This plan introduces **six architectural changes** that transform the pipeline from concept-transfer to style-faithful-transfer:

1. **Deep Niche Cultural Map** — Replace shallow keyword arrays with structured cultural intelligence
2. **Source Style Extraction** — Vision LLM analyzes each source image into a structured StyleJSON
3. **Three-Mode Generation** — Edit-source, style-reference, or prompt-only based on adaptation distance
4. **Approval/Rejection Signal System** — Every user decision feeds back into future generation
5. **Two-Output Pipeline** — Preview mockups at scan time; DTF extraction only after approval
6. **Schema Changes** — New columns on `trend_patterns`, expanded `nicheProfile` JSON blob

---

## Problem Statement

| Problem | Current Behavior | Desired Behavior |
|---------|-----------------|-----------------|
| Style fidelity | Fish-bone style source → cartoon skeleton badge output | Fish-bone style source → fish-bone style pickleball output |
| Niche depth | Surface keywords: "pickleball", "dink" | Deep cultural map: mascots, pain points, inside jokes, physical comedy |
| Generation mode | One static prompt template for all designs | Three modes selected by LLM based on adaptation distance |
| Learning | Approve/dismiss flips a status flag, no signal recorded | Every approval/rejection records reason + feeds future weighting |
| DTF timing | Production images generated immediately at scan time | DTF extraction only after user approves (saves API calls) |
| Source image usage | Fetched and stored but never used for generation | Passed as reference image for edit-mode or style-reference generation |

---

## A. Deep Niche Cultural Map

### Current State

The `nicheProfile` JSON blob on the workspace has this shape:

```typescript
{
  summary: string;
  targetAudience: string;
  subreddits: string[];
  etsyKeywords: string[];
  crossNicheCategories: string[];
  culturalMoments: string[];    // ← shallow string array
  designStyles: string[];
  avoidTopics: string[];
}
```

The `culturalMoments` field is a flat list of strings like `"kitchen line", "dinking", "third shot drop"`. This is too shallow to drive intelligent cross-niche adaptation. When the system sees a Bigfoot shirt, it has no structured knowledge about what pickleball mascots exist, what physical comedy scenarios resonate, or what rivalries drive purchases.

### Proposed Schema

Expand the `nicheProfile` JSON blob (no SQL migration needed — it's already a JSON column):

```typescript
interface NicheProfile {
  // ─── Existing fields (unchanged) ───
  summary: string;
  targetAudience: string;
  subreddits: string[];
  etsyKeywords: string[];
  crossNicheCategories: string[];
  designStyles: string[];
  avoidTopics: string[];

  // ─── NEW: Deep Cultural Map ───
  culturalMap: {
    animalMascots: Array<{
      animal: string;           // "Llama", "T-Rex", "Angry Crab"
      whyItWorks: string;       // "Short arms = can't reach high volleys"
      visualTreatment: string;  // "Anthropomorphized, wearing headband"
    }>;
    painPoints: Array<{
      pain: string;             // "Elbow tendonitis from overplay"
      humorAngle: string;       // "Badge of honor / addiction framing"
    }>;
    funPoints: Array<{
      joy: string;              // "The satisfying 'pop' of a perfect dink"
      visualConcept: string;    // "Sound effect typography, onomatopoeia"
    }>;
    insideJokes: Array<{
      joke: string;             // "It's not a sport, it's a lifestyle"
      context: string;          // "Said by obsessed players to confused family"
    }>;
    physicalComedy: Array<{
      scenario: string;         // "Diving for a ball in rec league"
      whyFunny: string;         // "Contrast between casual game and Olympic effort"
    }>;
    catchphrases: string[];     // "Dink responsibly", "Stay out of the kitchen"
    lifestyleIdentity: Array<{
      trait: string;            // "Retired professionals who play 5x/week"
      purchaseDriver: string;   // "Identity signaling to other players"
    }>;
    rivalries: Array<{
      rivalry: string;          // "Pickleball vs Tennis"
      tension: string;          // "Court space wars, 'real sport' gatekeeping"
      humorAngle: string;       // "Smug superiority, 'we're having more fun'"
    }>;
    transferableVisualConcepts: Array<{
      sourceNiche: string;      // "Fishing"
      sourcePattern: string;    // "Bigfoot holding a fishing rod"
      targetAdaptation: string; // "Bigfoot holding a pickleball paddle"
      whyItTransfers: string;   // "Mythical creature + activity = absurdist humor"
    }>;
  };

  // ─── DEPRECATED (replaced by culturalMap.insideJokes + catchphrases) ───
  culturalMoments?: string[];   // Keep for backward compat, ignore in new code
}
```

### Wiring Changes

| File | Change |
|------|--------|
| `server/onboardingRouter.ts` | Rewrite `enrichNiche` LLM prompt to produce the full `culturalMap` structure. Add `culturalMap` to the strict JSON schema. Keep backward compat: if LLM returns old format, wrap in new structure. |
| `server/workspaceRouter.ts` | Expand `nicheProfile` zod schema in `workspace.update` to accept `culturalMap` object. Make it optional for backward compat. |
| `server/nicheHunter.ts` | Pass `culturalMap` into `deconstructAndAdapt()` so the LLM can make intelligent cross-niche transfers (e.g., "Bigfoot → Llama" not "Bigfoot → generic badge"). |
| `client/src/pages/WorkspaceSettings.tsx` | Add UI sections for viewing/editing cultural map entries (expandable cards per category). |
| `client/src/pages/OnboardingWizard.tsx` | Display cultural map in review step with edit capability. |

### Data Flow

```
User enters niche description
  → enrichNiche() LLM call (new deep prompt)
  → Returns full NicheProfile with culturalMap
  → User reviews/edits in wizard
  → finalizeWorkspace() stores on workspace.nicheProfile
  → computeBaseStyleProfile() uses culturalMap for richer style derivation
  → Niche Hunter scan uses culturalMap for intelligent adaptation
```

---

## B. Source Style Extraction System

### Current State

The Niche Hunter fetches source Etsy product images (`sourceImageUrl`) and stores them on `trendPatterns`, but **never analyzes them**. Image generation uses a single static prompt:

```typescript
const imagePrompt = `T-shirt design mockup: ${p.adaptedConcept}. Style: ${p.composition}. Colors: ${p.colorStrategy}. Print-on-demand apparel design, centered on blank t-shirt, high quality product mockup.`;
```

This prompt has no knowledge of the source image's actual ink technique, line weight, shading method, or composition style.

### Proposed Module: `server/styleExtractor.ts`

New file with one primary function:

```typescript
export interface SourceStyleJSON {
  // ─── Ink & Technique ───
  inkColors: string[];          // ["black", "burnt orange"]
  inkColorNames: string[];      // ["matte black", "distressed rust"]
  shirtColorRole: string;       // "negative space — shirt color IS the background"
  technique: string;            // "screen-print simulation", "DTG full-color", "vinyl cut"
  lineWeight: string;           // "thick bold outlines", "hairline detail", "no outlines"
  shadingMethod: string;        // "halftone dots", "crosshatch", "flat color", "gradient"
  textureDetail: string;        // "heavy distress/worn", "clean vector", "hand-drawn organic"

  // ─── Subject & Composition ───
  subject: string;              // "skeleton holding fishing rod"
  subjectCrop: string;          // "full body centered", "bust portrait", "close-up face"
  composition: string;          // "centered single subject", "badge/emblem", "scene"
  framingDevice: string;        // "circular badge border", "banner ribbon", "NONE"
  scaleCoverage: string;        // "fills 80% of print area", "small chest logo"

  // ─── Text & Mood ───
  textPresence: string;         // "bold headline above, subtext below", "NONE"
  textStyle: string;            // "distressed serif all-caps", "hand-lettered script"
  mood: string;                 // "irreverent humor", "vintage nostalgia", "aggressive"
  humorMechanism: string;       // "absurdist juxtaposition", "wordplay", "NONE"

  // ─── Print & Garment ───
  printMethod: string;          // "simulated screen-print", "DTG", "sublimation"
  garmentStyle: string;         // "dark heather tee", "natural cotton", "black hoodie"
  designEra: string;            // "1970s retro", "modern minimal", "timeless"
  backgroundTreatment: string;  // "transparent/no background", "white rectangle", "shirt IS bg"
}

export async function extractStyleFromImage(imageUrl: string): Promise<SourceStyleJSON>;
```

### Implementation

The function uses `invokeLLM()` with `image_url` content type (Vision LLM) and a strict JSON schema response format. The prompt instructs the LLM to analyze the product photo as a print-on-demand expert, focusing on reproducible visual attributes rather than subjective interpretation.

### Where It's Called

In `nicheHunter.ts`, **after** fetching each Etsy source image (line ~119) and **before** pattern deconstruction:

```
Step 1: Fetch Etsy hot sellers (with sourceImageUrl)
Step 1b: [NEW] Extract style from each source image → SourceStyleJSON
Step 2: Reddit signals
Step 3+4: Deconstruct + adapt (now with style context)
Step 5: Generate preview (now style-faithful)
Step 6: Rank
```

### Storage

New column on `trend_patterns` table: `sourceStyleJson` (JSON, nullable). Stored alongside the pattern after extraction.

---

## C. Three-Mode Generation System

### Current State

All designs generated with one approach:
```typescript
generateImage({ prompt: staticPromptString })
```

The `originalImages` parameter (edit mode) is never used in the Niche Hunter flow, even though it's already supported by `generateImage()` and proven in `revisionEngine.ts`.

### Proposed Three Modes

| Mode | When to Use | How It Works | Fidelity |
|------|-------------|--------------|----------|
| `edit_source` | Close adaptation (same composition, just swap subject) | Pass source Etsy product image as `originalImages[0]`, prompt: "Keep everything the same. Only change the printed graphic from [X] to [Y]." | Highest |
| `style_reference` | Medium adaptation (same style, different composition) | Pass source image as `originalImages[0]`, prompt: "Generate a new design in the exact same visual style. Subject: [Y]. Match ink colors, technique, line weight." | High |
| `prompt_only` | Far adaptation (only the pattern formula transfers) | No reference image. Build prompt from merged SourceStyleJSON + adaptedConcept. | Medium |

### Mode Selection Logic

New function in `server/nicheHunter.ts`:

```typescript
async function determineAdaptationMode(
  sourceStyle: SourceStyleJSON,
  adaptedConcept: string,
  culturalMap: CulturalMap
): Promise<{ mode: "edit_source" | "style_reference" | "prompt_only"; reasoning: string }>
```

This calls the LLM with the source style analysis and the adapted concept, asking it to classify:
- If the adaptation is a **direct subject swap** (same composition, same framing, just different character/object) → `edit_source`
- If the adaptation **changes composition** but should keep the same ink/technique/mood → `style_reference`
- If the adaptation is **fundamentally different** (only the emotional formula transfers) → `prompt_only`

### Prompt Construction Per Mode

**edit_source prompt template:**
```
Keep everything exactly the same — the shirt, scene, lighting, fabric texture, 
ink style, print technique, color palette, composition, and placement. 
Only change the printed graphic: replace [source subject] with [target subject].
Keep the same print style, ink colors, line weight, shading method, and worn texture.
Do NOT change the garment color, background, or any element besides the graphic subject.
```

**style_reference prompt template:**
```
Generate a t-shirt design with this EXACT visual style:
- Technique: {technique}
- Ink colors: {inkColors}
- Line weight: {lineWeight}
- Shading: {shadingMethod}
- Texture: {textureDetail}
- Composition: {composition}
- Scale: {scaleCoverage}
- Background: {backgroundTreatment}

Subject: {adaptedConcept}
The design must look like it was made by the same artist using the same tools.
Output as isolated artwork on transparent background.
```

**prompt_only prompt template (merged JSON approach):**
```
Generate a t-shirt graphic design. Transparent background. Isolated artwork only.

STYLE CONSTRAINTS (from source analysis):
{JSON.stringify(sourceStyleJSON, null, 2)}

SUBJECT: {adaptedConcept}

CRITICAL: Match the technique ({technique}), ink colors ({inkColors}), 
line weight ({lineWeight}), and shading method ({shadingMethod}) EXACTLY.
The design must fill {scaleCoverage} of the canvas.
Composition: {composition}. Framing device: {framingDevice}.
```

### Storage

New column on `trend_patterns` table: `adaptationMode` (varchar(20), nullable). Values: `edit_source`, `style_reference`, `prompt_only`.

---

## D. Approval/Rejection Signal System

### Current State

```typescript
// approvePattern — just flips status, creates concept immediately
await updateTrendPatternStatus(input.patternId, "approved");
const conceptId = await createConceptFromPattern(pattern, input.workspaceId);

// dismissPattern — just flips status
await updateTrendPatternStatus(input.patternId, "dismissed");
```

No reason is recorded. No signal is fed back. The system doesn't learn from user decisions.

### Proposed Changes

**New columns on `trend_patterns` table:**

| Column | Type | Purpose |
|--------|------|---------|
| `approvalReason` | text, nullable | Why user approved (free text or structured tags) |
| `rejectionReason` | text, nullable | Why user dismissed (free text or structured tags) |
| `approvedAt` | timestamp, nullable | When approved (for temporal analysis) |
| `dismissedAt` | timestamp, nullable | When dismissed (for temporal analysis) |

**Updated router mutations:**

```typescript
approvePattern: protectedProcedure
  .input(z.object({
    patternId: z.string(),
    workspaceId: z.string(),
    reason: z.string().max(500).optional(),  // NEW
    tags: z.array(z.string()).optional(),     // NEW: ["great_style", "perfect_subject", "love_composition"]
  }))
  .mutation(async ({ input }) => { ... })

dismissPattern: protectedProcedure
  .input(z.object({
    patternId: z.string(),
    reason: z.string().max(500).optional(),  // NEW
    tags: z.array(z.string()).optional(),     // NEW: ["wrong_style", "bad_subject", "too_generic"]
  }))
  .mutation(async ({ input }) => { ... })
```

**Signal computation function:**

```typescript
// server/signalWeights.ts (NEW)
export async function computeSignalWeights(workspaceId: string): Promise<SignalWeights> {
  // 1. Fetch all approved + dismissed patterns for this workspace
  // 2. Analyze: which source categories, styles, compositions, emotional hooks
  //    correlate with approvals vs rejections?
  // 3. Return weighted preferences:
  return {
    preferredStyles: [...],      // Styles from approved patterns
    avoidStyles: [...],          // Styles from rejected patterns
    preferredHooks: [...],       // Emotional hooks that get approved
    avoidHooks: [...],           // Hooks that get rejected
    preferredCategories: [...],  // Source categories that produce winners
    avoidCategories: [...],      // Categories that consistently get rejected
    stylePatterns: {...},        // SourceStyleJSON fields that correlate with approval
  };
}
```

**Integration points:**

| Where | How Signals Are Used |
|-------|---------------------|
| `deconstructAndAdapt()` | Prompt includes: "The user prefers designs with [X] style and rejects [Y]. Weight your adaptations accordingly." |
| `rankPatterns()` | Scoring prompt includes signal weights as additional ranking criteria |
| `fetchCrossNicheHotSellers()` | Preferred categories get searched first; avoided categories deprioritized |

### UI Changes

The Niche Hunter pattern cards get optional "Why?" buttons on approve/dismiss:
- Quick-tag chips: "Love the style", "Great subject", "Perfect for my audience" (approve)
- Quick-tag chips: "Wrong style", "Subject doesn't fit", "Too generic", "Already have similar" (dismiss)
- Optional free-text field for detailed reasoning

---

## E. Two-Output Pipeline (Preview + Deferred DTF)

### Current State

The pipeline currently:
1. Generates preview images at scan time (in `nicheHunter.ts`)
2. Immediately runs `processDesignForProduction()` after each generation (in `pipeline.ts`)
3. Stores production-ready transparent PNGs as `productionUrlA/B/C` on `designConcepts`

This wastes API calls on designs that will be rejected.

### Proposed Flow

```
SCAN TIME (automatic):
  → Generate preview image (style-faithful, using three-mode system)
  → Store as previewImageUrl on trend_patterns
  → NO production processing yet

APPROVAL TIME (user-triggered):
  → User approves pattern
  → System creates concept in library (existing behavior)
  → [NEW] Trigger DTF extraction asynchronously:
      1. Take the preview image
      2. Run AI extraction (isolate artwork from any background)
      3. Store as dtfImageUrl on trend_patterns
      4. Also store as productionUrlA on the created concept
  → User sees "Processing DTF..." indicator, then "DTF Ready" badge

MOCKUP TIME (user-triggered, existing):
  → Compositor reads productionUrlA (already transparent)
  → Composites onto shirt template
  → No background removal needed (already clean)
```

### New Column on `trend_patterns`

| Column | Type | Purpose |
|--------|------|---------|
| `dtfImageUrl` | text, nullable | Production-ready transparent PNG, generated only after approval |

### Updated `approvePattern` Flow

```typescript
approvePattern: protectedProcedure
  .input(z.object({ patternId, workspaceId, reason?, tags? }))
  .mutation(async ({ input }) => {
    // 1. Update status + record signal
    await updateTrendPatternStatus(input.patternId, "approved");
    await updateTrendPatternApproval(input.patternId, input.reason, input.tags);

    // 2. Create concept (existing)
    const conceptId = await createConceptFromPattern(pattern, input.workspaceId);

    // 3. [NEW] Trigger DTF extraction (async, non-blocking)
    if (pattern.previewImageUrl) {
      processDesignForProduction(pattern.previewImageUrl, conceptId, "A")
        .then(url => updateTrendPatternDtf(pattern.id, url))
        .catch(err => console.warn("[NicheHunter] DTF extraction failed:", err));
    }

    return { success: true, conceptId };
  })
```

---

## F. Database Schema Changes

All changes are additive (no destructive migrations):

### `trend_patterns` table — New Columns

```sql
ALTER TABLE trend_patterns
  ADD COLUMN sourceStyleJson JSON DEFAULT NULL
    COMMENT 'Vision LLM style extraction from source Etsy image',
  ADD COLUMN adaptationMode VARCHAR(20) DEFAULT NULL
    COMMENT 'edit_source | style_reference | prompt_only',
  ADD COLUMN approvalReason TEXT DEFAULT NULL
    COMMENT 'User reason for approving this pattern',
  ADD COLUMN rejectionReason TEXT DEFAULT NULL
    COMMENT 'User reason for dismissing this pattern',
  ADD COLUMN approvalTags JSON DEFAULT NULL
    COMMENT 'Structured tags: great_style, perfect_subject, etc.',
  ADD COLUMN rejectionTags JSON DEFAULT NULL
    COMMENT 'Structured tags: wrong_style, bad_subject, etc.',
  ADD COLUMN approvedAt TIMESTAMP DEFAULT NULL
    COMMENT 'When the pattern was approved',
  ADD COLUMN dismissedAt TIMESTAMP DEFAULT NULL
    COMMENT 'When the pattern was dismissed',
  ADD COLUMN dtfImageUrl TEXT DEFAULT NULL
    COMMENT 'Production-ready transparent PNG (generated on approval only)';
```

### `workspaces.nicheProfile` — JSON Expansion

No SQL migration needed. The `nicheProfile` column is already `JSON` type. The expanded structure (with `culturalMap`) is backward-compatible — old workspaces simply won't have the `culturalMap` key, and all code checks for its existence before using it.

### Drizzle Schema Update

```typescript
// In drizzle/schema.ts — trend_patterns table additions:
sourceStyleJson: json("sourceStyleJson").$type<SourceStyleJSON>(),
adaptationMode: varchar("adaptationMode", { length: 20 }),
approvalReason: text("approvalReason"),
rejectionReason: text("rejectionReason"),
approvalTags: json("approvalTags").$type<string[]>(),
rejectionTags: json("rejectionTags").$type<string[]>(),
approvedAt: timestamp("approvedAt"),
dismissedAt: timestamp("dismissedAt"),
dtfImageUrl: text("dtfImageUrl"),
```

---

## G. New File Map

| New File | Purpose | Lines (est.) |
|----------|---------|-------------|
| `server/styleExtractor.ts` | `extractStyleFromImage()` — Vision LLM → SourceStyleJSON | ~120 |
| `server/signalWeights.ts` | `computeSignalWeights()` — analyze approve/reject history | ~80 |
| `shared/sourceStyleJson.ts` | TypeScript interface for SourceStyleJSON (shared type) | ~50 |

| Modified File | Changes |
|---------------|---------|
| `server/nicheHunter.ts` | Add style extraction step, three-mode generation, pass culturalMap to adaptation |
| `server/nicheHunterDb.ts` | Add helpers: `updateTrendPatternStyle()`, `updateTrendPatternDtf()`, `updateTrendPatternApproval()` |
| `server/nicheHunterRouter.ts` | Expand approve/dismiss inputs, trigger DTF on approval |
| `server/onboardingRouter.ts` | Rewrite enrichment prompt for deep cultural map |
| `server/workspaceRouter.ts` | Expand nicheProfile zod schema |
| `server/styleIntelligence.ts` | Use culturalMap in `computeBaseStyleProfile()` |
| `drizzle/schema.ts` | Add new columns to trendPatterns |
| `client/src/pages/NicheHunter.tsx` | Add reason/tag UI on approve/dismiss |
| `client/src/pages/WorkspaceSettings.tsx` | Add cultural map display/edit sections |
| `client/src/pages/OnboardingWizard.tsx` | Display cultural map in review step |

---

## H. Implementation Order (Phases)

Ordered by dependency chain — each phase is independently deployable and testable:

| Phase | What | Depends On | Verification |
|-------|------|-----------|-------------|
| 1 | Schema migration (add all new columns) | Nothing | `pnpm drizzle-kit generate` + SQL applied, 0 TSC errors |
| 2 | `shared/sourceStyleJson.ts` type definition | Phase 1 | TypeScript compiles |
| 3 | `server/styleExtractor.ts` — extractStyleFromImage() | Phase 2 | Unit test: pass known Etsy image URL → get valid SourceStyleJSON back |
| 4 | Wire style extraction into nicheHunter.ts (Step 1b) | Phase 3 | Scan produces patterns with `sourceStyleJson` populated |
| 5 | Three-mode generation in nicheHunter.ts | Phase 4 | Scan produces patterns with `adaptationMode` set, preview images match source style |
| 6 | Deep cultural map schema + onboarding prompt rewrite | Phase 1 | New workspace onboarding produces full culturalMap |
| 7 | Cultural map wired into deconstructAndAdapt() | Phase 6 | Adapted concepts reference specific mascots/jokes from culturalMap |
| 8 | Approval/rejection signal system (schema + router + UI) | Phase 1 | Approve/dismiss records reason + tags, timestamps set |
| 9 | `server/signalWeights.ts` + wiring into scan | Phase 8 | After 5+ approvals/rejections, scan prompt includes signal context |
| 10 | Deferred DTF extraction (approval-triggered) | Phase 1 | Approving a pattern triggers async DTF processing, dtfImageUrl populated |

---

## I. What This Plan Does NOT Change

Per Karpathy Principle 3 (Surgical Changes), the following are explicitly out of scope:

- **NYT book pipeline** — Untouched. Only the niche_hunter flow is modified.
- **Mockup compositor** — Already working correctly (contain fit, no fill ratio). No changes.
- **Production image processor** — Stays as-is for concept library. DTF for patterns uses the same function.
- **Revision engine** — Untouched. Already uses edit-with-reference correctly.
- **Product groups / templates** — Untouched.
- **Listing builder** — Untouched.
- **Vision LLM QA check** — Stays internal (toast already suppressed in this commit).

---

## J. Success Criteria

The architecture is working when:

1. **Style fidelity test:** Take the Bigfoot dandelion Etsy shirt → system extracts its style (minimalist line art, 2-color, centered character, no text) → generates a pickleball version in the **same** visual style (not a cartoon badge).

2. **Cultural map test:** System suggests "Llama with short arms trying to reach a high volley" (from culturalMap.animalMascots) instead of "generic pickleball player" when adapting an animal-humor source.

3. **Edit-source test:** For a close adaptation (same composition, just swap fish→paddle), the system passes the source image as reference and outputs a design that looks like a minor edit of the original.

4. **Signal learning test:** After user approves 3 "vintage distressed" patterns and rejects 3 "modern minimal" patterns, the next scan's ranking and adaptation prompts explicitly prefer vintage distressed.

5. **DTF timing test:** Scanning produces preview images but NO dtfImageUrl. After approval, dtfImageUrl appears within 30 seconds.

---

## K. PO Decisions (Answered June 1, 2026)

| # | Question | PO Decision | Implementation Impact |
|---|----------|-------------|----------------------|
| 1 | Cultural map regeneration | **One-time at onboarding only.** No "Regenerate" button in workspace settings. | Simplifies UI. `culturalMap` is set once during `finalizeWorkspace()` and only editable manually via workspace settings fields. No re-enrichment endpoint needed. |
| 2 | Signal weight visibility | **YES — show the user what the system has learned.** | Add a "Style Preferences" card in Niche Hunter or Workspace Settings that displays computed signal weights (e.g., "Preferred: vintage distressed (5 approvals)"). Read-only summary from `computeSignalWeights()`. |
| 3 | Edit-source failure handling | **FLAG and let the user decide.** No automatic retry. | When edit-source mode is used, show a small badge/indicator on the pattern card: "Edit Mode — verify style match". User can dismiss or request regeneration in a different mode via the existing revision flow. |
| 4 | Batch size cap | **Yes, cap at 8 patterns per scan.** PO follow-up: "Will new runs look at the same patterns or produce new ones?" | New runs always produce NEW patterns (different Etsy hot sellers, different Reddit signals). The system never re-discovers the same pattern twice — existing patterns are deduplicated by `sourceListingUrl`. Cap implementation: limit the final ranked output to 8 patterns max in `rankPatterns()`. |
| 5 | Existing patterns backfill | **Only on-demand** — when user explicitly asks to generate more images or requests "with what style to generate them at". No automatic backfill. | No backfill button for style extraction. Style extraction runs only on NEW patterns during fresh scans, or when user triggers a regeneration action on a specific existing pattern. |

---

*PO has approved this plan. Implementation may proceed in the phased order defined in Section H.*
