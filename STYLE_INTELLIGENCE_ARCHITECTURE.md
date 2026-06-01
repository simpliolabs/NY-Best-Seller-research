# Style Intelligence Architecture Plan

> Karpathy P1: State assumptions explicitly. Surface tradeoffs.
> Karpathy P2: Minimum code that solves the problem. Nothing speculative.

---

## Problem Statement

The image generation pipeline produces cartoonish clip-art because:
1. **One-size-fits-all prompt** — `IMAGE_PROMPT_SYSTEM` references "World Bible", "illustrator style", and IP-specific language that is meaningless for niche workspaces
2. **No style derivation** — The system collects rich research data (niche research, trend patterns, community signals) but NEVER feeds visual style intelligence into the image generation prompt
3. **No competitive reverse-engineering at image-gen time** — The Niche Hunter already deconstructs winning designs into `composition`, `colorStrategy`, `emotionalHook`, etc. — but this data is stored in `trend_patterns` and never read by Stage 6

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     STYLE INTELLIGENCE LAYER                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  NICHE WORKSPACES (two-phase):                                  │
│                                                                  │
│    Phase A — Onboarding-time (runs ONCE at workspace creation): │
│      1. nicheProfile.designStyles + crossNicheCategories         │
│      2. LLM call → derive BASE STYLE PROFILE (JSON)             │
│      3. Store on workspace row as `styleProfile` field           │
│                                                                  │
│    Phase B — Pipeline-time (runs EVERY pipeline run):            │
│      1. Load workspace.styleProfile (base)                       │
│      2. Load approved trend_patterns for this workspace          │
│      3. Load niche_research.designStyles for this run's books    │
│      4. LLM call → compute RUN STYLE DIRECTIVES (per-run)       │
│      5. Feed directives into IMAGE_PROMPT_SYSTEM selection       │
│                                                                  │
│  NYT WORKSPACES (pipeline-time only):                           │
│                                                                  │
│    Phase B — Pipeline-time (runs EVERY pipeline run):            │
│      1. Load book.worldBible (existing)                          │
│      2. Load niche_research.designStyles for this book           │
│      3. LLM call → compute BOOK STYLE DIRECTIVES (per-book)     │
│      4. Feed directives into IMAGE_PROMPT_SYSTEM                 │
│         (replaces blind worldBible copy with market-aware style) │
│                                                                  │
│  OVERRIDE (both workspace types):                               │
│      workspace.styleOverride (JSON, nullable) — user can         │
│      force specific style parameters that override computed ones │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model Changes

### New fields on `workspaces` table:

```ts
// drizzle/schema.ts — add to workspaces table
styleProfile: json("styleProfile").$type<StyleProfile>(),
styleOverride: json("styleOverride").$type<Partial<StyleProfile>>(),
```

### StyleProfile type (new shared type):

```ts
// shared/styleProfile.ts
export interface StyleProfile {
  /** Primary aesthetic direction, e.g. "vintage screen-print", "modern minimal", "hand-drawn organic" */
  primaryAesthetic: string;
  /** 2-4 color constraints: palette type + specific guidance */
  colorDirective: string;
  /** Max ink colors for DTF (2-4 for vintage, 4-6 for modern) */
  maxColors: number;
  /** Texture/distress level: "heavy-vintage", "moderate-worn", "clean-modern", "hand-drawn" */
  textureLevel: string;
  /** Composition preferences: "badge-emblem", "typography-forward", "illustration-centered", "scattered-layout" */
  compositionPreferences: string[];
  /** Typography style: "distressed-serif", "bold-condensed-sans", "hand-lettered", "retro-script" */
  typographyStyle: string;
  /** What to AVOID — anti-patterns for this niche/book */
  avoidDirectives: string[];
  /** Market reference: what top sellers in this space look like */
  marketReference: string;
  /** Confidence: "computed" | "override" | "hybrid" */
  source: "computed" | "override" | "hybrid";
}
```

### New field on `books` table (NYT only):

```ts
// drizzle/schema.ts — add to books table
styleDirectives: json("styleDirectives").$type<StyleProfile>(),
```

---

## Wiring Plan — Exact Code Changes

### File 1: `shared/styleProfile.ts` (NEW — ~30 lines)

Create the shared type definition. Used by both server and (future) client.

---

### File 2: `drizzle/schema.ts` (2 field additions)

```ts
// In workspaces table:
styleProfile: json("styleProfile").$type<StyleProfile>(),
styleOverride: json("styleOverride").$type<Partial<StyleProfile>>(),

// In books table:
styleDirectives: json("styleDirectives").$type<StyleProfile>(),
```

Migration SQL:
```sql
ALTER TABLE workspaces ADD COLUMN styleProfile JSON DEFAULT NULL;
ALTER TABLE workspaces ADD COLUMN styleOverride JSON DEFAULT NULL;
ALTER TABLE books ADD COLUMN styleDirectives JSON DEFAULT NULL;
```

---

### File 3: `server/styleIntelligence.ts` (NEW — ~200 lines)

Two exported functions:

#### `computeBaseStyleProfile(nicheProfile: NicheProfile): Promise<StyleProfile>`

Called ONCE at workspace creation (onboarding-time).

**Input:** The nicheProfile from onboarding (designStyles, crossNicheCategories, targetAudience, avoidTopics)

**Logic:** Single LLM call that:
- Analyzes what visual styles resonate with this niche's audience
- Reverse-engineers what top sellers in adjacent categories look like
- Derives a concrete StyleProfile with specific constraints

**System prompt (abbreviated):**
```
You are a print-on-demand market analyst specializing in visual style strategy.
Given a niche profile, derive the optimal visual style for t-shirt designs that will
sell to this audience. Base your analysis on what ACTUALLY SELLS in this market —
not generic design theory.

Consider:
- What do top Etsy sellers in this niche look like? (vintage? modern? hand-drawn?)
- What color palettes dominate best-sellers? (muted earth tones? bold primaries? pastels?)
- What texture level sells? (distressed/worn? clean/modern? hand-drawn?)
- What composition types dominate? (badges? typography-forward? illustration-centered?)

Return a JSON StyleProfile...
```

#### `computeRunStyleDirectives(opts): Promise<StyleProfile>`

Called at pipeline-time (Stage 5.5 — between scoring and image gen).

**Input for niche_hunter:**
```ts
{
  baseProfile: workspace.styleProfile,       // from onboarding
  override: workspace.styleOverride,         // user override (nullable)
  approvedPatterns: TrendPattern[],          // from nicheHunterDb
  nicheResearch: NicheResearch[],            // from this run
  workspaceType: "niche_hunter",
}
```

**Input for NYT:**
```ts
{
  book: Book,                                // worldBible, mood, setting, subgenre
  nicheResearch: NicheResearch,              // designStyles for this book
  workspaceType: "nyt",
}
```

**Logic:** Single LLM call that:
- For niche_hunter: merges base profile + approved pattern aesthetics + this run's research into a final directive
- For NYT: analyzes what merch style would actually sell for this book's fandom (not just copy the cover art)
- Respects overrides: if `styleOverride` has values, those fields are locked and not recomputed

**Returns:** A resolved `StyleProfile` that gets passed directly to the image prompt system.

---

### File 4: `server/pipeline.ts` — Stage 5.5 insertion + IMAGE_PROMPT_SYSTEM branch (~80 lines changed)

#### Change 1: New Stage 5.5 — Compute Style Directives (after scoring, before image gen)

Insert between Stage 5 (scoring) and Stage 6 (image gen):

```ts
// Stage 5.5: Compute Style Intelligence (non-blocking, graceful degradation)
await updateRunStage(runId, 5, "Computing visual style directives...");
const styleDirectivesMap = new Map<number, StyleProfile>();

if (workspaceType === "niche_hunter") {
  // Load workspace base style + approved patterns
  const { getWorkspaceById } = await import("./workspaceDb");
  const ws = await getWorkspaceById(workspaceId);
  const approvedPatterns = await getTrendPatternsByWorkspace(workspaceId, "approved");
  const nicheRecords = await getNicheResearchByRunId(runId);
  
  const directive = await computeRunStyleDirectives({
    baseProfile: ws?.styleProfile as StyleProfile | undefined,
    override: ws?.styleOverride as Partial<StyleProfile> | undefined,
    approvedPatterns,
    nicheResearch: nicheRecords,
    workspaceType: "niche_hunter",
  });
  
  // Same directive for all books in a niche workspace
  for (const book of dbBooks) {
    styleDirectivesMap.set(book.id, directive);
    await updateBookStyleDirectives(book.id, directive);
  }
} else {
  // NYT: per-book style directives
  const nicheRecords = await getNicheResearchByRunId(runId);
  for (const book of dbBooks) {
    const bookNiche = nicheRecords.find(nr => nr.bookId === book.id);
    const directive = await computeRunStyleDirectives({
      book,
      nicheResearch: bookNiche ?? undefined,
      workspaceType: "nyt",
    });
    styleDirectivesMap.set(book.id, directive);
    await updateBookStyleDirectives(book.id, directive);
  }
}
```

#### Change 2: New `NICHE_IMAGE_PROMPT_SYSTEM` constant

A new image prompt system that replaces World Bible references with StyleProfile directives:

```ts
const NICHE_IMAGE_PROMPT_SYSTEM = `You are a senior art director...
// Same 10-layer formula but:
// [2] STYLE ANCHOR → reads from StyleProfile.primaryAesthetic + textureLevel
// [5] WORLD-ACCURATE DETAILS → replaced with NICHE-ACCURATE DETAILS (community objects, symbols)
// [9] COLOR DECLARATION → constrained by StyleProfile.maxColors + colorDirective
// All "World Bible" references → "Style Directives"
// Adds: "MARKET REFERENCE: ${styleProfile.marketReference}" as context
// Adds: "AVOID: ${styleProfile.avoidDirectives.join(', ')}" as hard constraint
`;
```

#### Change 3: `stageDesignExpansion` reads styleDirectives

In the `promptTasks` loop (line ~1084), after fetching the book:

```ts
const styleDirectives = book.styleDirectives as StyleProfile | null;
const promptSystem = styleDirectives 
  ? buildImagePromptSystem(styleDirectives)  // new helper
  : IMAGE_PROMPT_SYSTEM;                     // fallback to existing

// User message also changes: replace [BOOK_WORLD_BIBLE] section with [STYLE_DIRECTIVES]
const userMsg = styleDirectives
  ? buildNicheUserMessage(concept, styleDirectives)
  : buildLegacyUserMessage(concept, book);   // existing behavior
```

---

### File 5: `server/onboardingRouter.ts` — Post-create style computation (~15 lines)

After `createWorkspace()` in `finalizeWorkspace`, fire-and-forget the base style computation:

```ts
const workspace = await createWorkspace({ ... });

// Fire-and-forget: compute base style profile from niche research
void (async () => {
  try {
    const { computeBaseStyleProfile } = await import("./styleIntelligence");
    const profile = await computeBaseStyleProfile(input.nicheProfile);
    await updateWorkspace(workspace.id, { styleProfile: profile });
    console.log(`[Onboarding] Base style profile computed for workspace ${workspace.id}`);
  } catch (err) {
    console.warn(`[Onboarding] Base style computation failed (non-fatal):`, err);
  }
})();

return workspace;
```

---

### File 6: `server/workspaceDb.ts` — Accept new fields in updateWorkspace (~3 lines)

Add `styleProfile` and `styleOverride` to the `updateWorkspace` fields type:

```ts
export async function updateWorkspace(
  id: string,
  fields: Partial<Pick<InsertWorkspace, "name" | "icon" | "pipelineConfig" | "nicheProfile" | "descriptionTemplate" | "styleProfile" | "styleOverride">>
): Promise<Workspace> { ... }
```

---

### File 7: `server/db.ts` — New helper `updateBookStyleDirectives` (~8 lines)

```ts
export async function updateBookStyleDirectives(bookId: number, directives: StyleProfile): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(books).set({ styleDirectives: directives }).where(eq(books.id, bookId));
}
```

---

### File 8: `server/bookRefresh.ts` — Consume style directives (~10 lines)

The book refresh path currently has its own concept generation prompt. After this change:
- It reads `book.styleDirectives` (already computed from the last full run)
- If present, it uses the style-aware concept generation prompt
- If absent (book never had a full run with style intelligence), falls back to existing behavior

---

### File 9: `server/workspaceRouter.ts` — Expose styleOverride in update (~5 lines)

Add `styleOverride` to the `workspace.update` input schema so users can set overrides from the UI.

---

## Execution Order (Karpathy P4: Goal-Driven)

| Step | Action | Verify |
|------|--------|--------|
| 1 | Create `shared/styleProfile.ts` | TSC passes |
| 2 | Add schema fields + run migration SQL | DB columns exist |
| 3 | Create `server/styleIntelligence.ts` | TSC passes, unit test for type shape |
| 4 | Wire onboarding post-create call | Create workspace → styleProfile populated |
| 5 | Wire pipeline Stage 5.5 | Run pipeline → books get styleDirectives |
| 6 | Create `NICHE_IMAGE_PROMPT_SYSTEM` + branch in stageDesignExpansion | TSC passes |
| 7 | Wire `buildImagePromptSystem()` helper | Image prompts use style directives |
| 8 | Update bookRefresh.ts to read styleDirectives | TSC passes |
| 9 | Add styleOverride to workspace.update | API accepts override payload |
| 10 | Full pipeline test run | Images match market aesthetic |

---

## What This Does NOT Do (Scope Lock)

- **No new UI pages** — style profile is computed automatically; override UI is a separate feature
- **No new database tables** — uses existing `workspaces` and `books` tables with new JSON columns
- **No changes to concept generation prompts** — only image generation prompts change
- **No changes to scoring** — style intelligence affects visual output, not concept scoring
- **No changes to Niche Hunter scan engine** — it continues producing trend_patterns; we just READ them at pipeline-time
- **No changes to the existing NYT IMAGE_PROMPT_SYSTEM** — it remains as fallback; new system is additive

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Style LLM call fails | Graceful degradation: if `computeRunStyleDirectives` fails, fall back to existing IMAGE_PROMPT_SYSTEM |
| Onboarding style computation slow | Fire-and-forget: workspace is returned immediately, style computes in background |
| NYT books get wrong style | Per-book computation: each book gets its own directive based on its worldBible + niche research |
| Override conflicts with computed | Override fields are locked: if user sets `maxColors: 3`, that field is never recomputed |
| bookRefresh drift | Explicit: bookRefresh reads `book.styleDirectives` from last full run |
| regenerateImages drift | No drift: `regenerateImagesForRun` calls `stageDesignExpansion` which reads `book.styleDirectives` from DB |

---

## Key Architectural Decision: Reuse Niche Hunter Patterns

The Niche Hunter already does the "reverse engineer the look" work:
- `deconstructAndAdapt()` extracts `composition`, `colorStrategy`, `emotionalHook` per pattern
- `rankPatterns()` scores them against the workspace's audience
- Patterns are stored with `approved`/`dismissed` status

**Style Intelligence READS these patterns** — it does not duplicate the analysis. The `computeRunStyleDirectives` function for niche_hunter workspaces loads all `approved` patterns and synthesizes their collective aesthetic into a single `StyleProfile` directive.

This means:
1. Running Niche Hunter scans improves image quality (more approved patterns = better style intelligence)
2. Approving/dismissing patterns directly influences the next pipeline run's visual output
3. No redundant LLM calls — pattern analysis is done once in Niche Hunter, consumed many times in pipeline

---

## Files Changed Summary

| File | Change Type | Lines |
|------|------------|-------|
| `shared/styleProfile.ts` | NEW | ~30 |
| `drizzle/schema.ts` | ADD 3 fields | ~6 |
| `server/styleIntelligence.ts` | NEW | ~200 |
| `server/pipeline.ts` | ADD Stage 5.5 + prompt branch | ~80 |
| `server/onboardingRouter.ts` | ADD post-create call | ~15 |
| `server/workspaceDb.ts` | EXTEND updateWorkspace | ~3 |
| `server/db.ts` | ADD helper | ~8 |
| `server/bookRefresh.ts` | READ styleDirectives | ~10 |
| `server/workspaceRouter.ts` | ADD styleOverride input | ~5 |
| **Total** | | **~360 lines** |

---

## Assumptions (Karpathy P1)

1. The existing `IMAGE_PROMPT_SYSTEM` 10-layer formula is sound for DTF printing — we keep the structure, just replace the style/color/texture inputs
2. The Niche Hunter's `approved` patterns represent the user's validated style preferences
3. A single `StyleProfile` per workspace is sufficient for niche_hunter (all signals in one niche share an aesthetic)
4. Per-book `StyleProfile` is needed for NYT because each book has a distinct visual universe
5. The user wants automatic intelligence FIRST, with override as a safety valve — not the other way around
6. Fire-and-forget for onboarding-time computation is acceptable (workspace is usable immediately, style arrives within ~10s)
