# Pipeline Transformation Plan: Workspace-Aware Sourcing

**Principles:** Karpathy — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution

---

## 1. Problem Statement

Today `runPipeline(nytApiKey, etsyApiKey)` is a global function with no workspace awareness. It always calls `stageIngest(nytApiKey)` which fetches NYT Bestseller books. For `niche_hunter` workspaces, Stage 1 should instead source trending signals from Reddit (niche subreddits) + Etsy (in-niche keywords) using the workspace's `nicheProfile`.

**Goal:** Add a workspace-type branch at the orchestrator level so:
- NYT workspace → unchanged path (backward compatible)
- niche_hunter workspace → new `stageNicheIngest(workspaceId)` → same Stages 2-7

---

## 2. Current Architecture (Seams Identified)

| Layer | Current State | What Needs to Change |
|-------|--------------|---------------------|
| **Trigger** (`routers.ts:79`) | `triggerRun` is a zero-input mutation. Calls `runPipeline(nytApiKey, etsyApiKey)` | Must accept `workspaceId` input. Branch on workspace type. |
| **Orchestrator** (`pipeline.ts:1191`) | `runPipeline(nytApiKey, etsyApiKey)` — no workspace param | New signature: `runPipeline(opts: { workspaceId, nytApiKey?, etsyApiKey? })` |
| **Stage 1** (`pipeline.ts:86-128`) | `stageIngest(nytApiKey)` → fetches NYT API → returns `RawBook[]` | For niche_hunter: new `stageNicheIngest(nicheProfile)` → returns same `RawBook[]` shape |
| **DB: bot_runs** (schema.ts:34-48) | No `workspaceId` column | Add `workspaceId` column (nullable for backward compat with existing runs) |
| **DB: createRun** (db.ts:120-125) | `createRun()` inserts bare row | `createRun(workspaceId?)` — pass workspace ID |
| **DB: listRuns** (db.ts:207-211) | Global query, no workspace filter | Add `listRunsByWorkspace(workspaceId)` |
| **Resume** (`pipeline.ts:1664`) | `resumePipeline` always calls `stageIngest(nytApiKey)` | Must check workspace type and branch |
| **Frontend trigger** (Dashboard.tsx, Status.tsx) | `triggerRun` called with no input | Pass `activeWorkspace.id` as input |

---

## 3. The "RawBook" Abstraction (Key Insight)

The `RawBook` type is the contract between Stage 1 and Stages 2-7:

```ts
type RawBook = {
  title: string;      // For niche: the trending topic/product name
  author: string;     // For niche: "Reddit" or "Etsy" (source attribution)
  isbn: string;       // For niche: a generated unique ID (e.g., "niche-{hash}")
  coverUrl: string;   // For niche: best-selling listing image URL (or empty)
  synopsis: string;   // For niche: aggregated signal text (subreddit posts, Etsy descriptions)
  rank: number;       // For niche: computed relevance rank
  weeksOnList: number; // For niche: 0 (not applicable)
};
```

**This is the simplest possible approach.** By mapping niche signals into the existing `RawBook` shape, Stages 2-7 work unchanged. The `books` table already has nullable `isbn`, `rank`, `weeksOnList` — no schema change needed for the book rows themselves.

---

## 4. Implementation Steps (Surgical)

### Step 1: Schema — Add `workspaceId` to `bot_runs`

```sql
ALTER TABLE bot_runs ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;
```

- Nullable: existing NYT runs keep `NULL` (backward compatible)
- New runs get the workspace ID

### Step 2: DB helpers — workspace-aware run creation and listing

In `db.ts`:
- `createRun(workspaceId?: string)` → pass to insert
- `listRunsByWorkspace(workspaceId: string)` → filter by workspaceId
- `getLatestRunByWorkspace(workspaceId: string)` → latest for a workspace

### Step 3: New source function — `stageNicheIngest`

In `pipeline.ts`, add a new function alongside `stageIngest`:

```ts
async function stageNicheIngest(nicheProfile: NicheProfile, etsyApiKey?: string): Promise<RawBook[]> {
  // 1. Scrape Reddit: use nicheProfile.subreddits
  //    - For each subreddit, call LLM to simulate trending posts (same pattern as forumScraper)
  //    - Extract: trending topics, hot phrases, pain points
  //
  // 2. Search Etsy: use nicheProfile.etsyKeywords
  //    - For each keyword, fetch top listings from Etsy API
  //    - Extract: bestseller titles, tags, price points, favorites
  //
  // 3. Merge + rank signals by relevance
  //    - Combine Reddit trends + Etsy bestsellers
  //    - Deduplicate by theme
  //    - Rank by signal strength (Reddit upvotes + Etsy favorites)
  //
  // 4. Return top N as RawBook[] shape
  //    - title = trending topic/theme name
  //    - author = source ("Reddit+Etsy")
  //    - isbn = generated unique ID ("niche-{slug}-{hash}")
  //    - synopsis = aggregated signal text
  //    - rank = computed rank
  //    - coverUrl = best Etsy listing image (if available)
}
```

**Key constraint:** This function returns `RawBook[]` — the same shape as `stageIngest`. Everything downstream is unchanged.

### Step 4: Orchestrator — branch on workspace type

Modify `runPipeline` signature:

```ts
export async function runPipeline(opts: {
  workspaceId: string;
  nytApiKey?: string;
  etsyApiKey?: string;
}): Promise<number>
```

Inside the orchestrator, after `createRun(workspaceId)`:

```ts
const workspace = await getWorkspaceById(workspaceId);
let rawBooks: RawBook[];

if (workspace.workspaceType === "nyt") {
  // Existing NYT path — unchanged
  rawBooks = await stageIngest(opts.nytApiKey!);
} else {
  // Niche Hunter workspace — new source
  rawBooks = await stageNicheIngest(workspace.nicheProfile as NicheProfile, opts.etsyApiKey);
}
```

Everything after this branch (upsert, Stage 2-7) stays identical.

### Step 5: Trigger — workspace-aware input

In `routers.ts`, change `triggerRun`:

```ts
triggerRun: protectedProcedure
  .input(z.object({ workspaceId: z.string() }))
  .mutation(async ({ input }) => {
    const workspace = await getWorkspaceById(input.workspaceId);
    if (!workspace) return { success: false, message: "Workspace not found", runId: null };

    if (workspace.workspaceType === "nyt") {
      const nytApiKey = process.env.NYT_API_KEY;
      if (!nytApiKey) return { success: false, message: "NYT_API_KEY not configured", runId: null };
      // ... start pipeline with nytApiKey
    } else {
      // niche_hunter — no NYT key needed
      // ... start pipeline with workspace context
    }
  })
```

### Step 6: Resume — workspace-aware

In `resumePipeline`, look up the workspace from the run's `workspaceId` and branch Stage 1 accordingly.

### Step 7: Frontend — pass workspaceId

In Dashboard.tsx and Status.tsx, change the mutation call:
```ts
triggerRun.mutate({ workspaceId: activeWorkspace.id })
```

### Step 8: Reports/History — workspace-scoped queries

- `listHistory` → filter by workspace
- `getLatest` → filter by workspace
- Status page stage labels: dynamic based on workspace type ("Fetching NYT Best Sellers..." vs "Scanning niche signals...")

---

## 5. What Does NOT Change

- Stages 2-7 code: zero modifications
- `books` table schema: no changes (niche signals map into existing columns)
- `design_concepts`, `niche_research`, `market_validation` tables: no changes
- `forumScraper.ts`: no changes (used as-is by Stage 2c for both paths)
- `bookRefresh.ts`: no changes (operates on existing book rows)
- `nicheHunter.ts` / `nicheHunterRouter.ts`: no changes (stays separate)
- `selfHeal.ts`: no changes
- Image generation (Stage 6): no changes
- World Bible extraction (Stage 2b): no changes

---

## 6. Verification Criteria (Goal-Driven)

| Step | Verify |
|------|--------|
| Schema migration | `DESCRIBE bot_runs` shows `workspaceId` column |
| DB helpers | Unit test: `createRun("ws-123")` → run has workspaceId; `listRunsByWorkspace("ws-123")` returns only that workspace's runs |
| stageNicheIngest | Unit test: given a mock nicheProfile, returns valid `RawBook[]` with ≥1 entry |
| Orchestrator branch | Integration test: NYT workspace → calls stageIngest; niche_hunter workspace → calls stageNicheIngest |
| Trigger mutation | Test: calling with NYT workspace requires NYT_API_KEY; calling with niche_hunter workspace does NOT require NYT_API_KEY |
| Frontend | Browser: Dashboard "Run Pipeline" button passes workspaceId; Status page shows correct stage labels per workspace type |
| Backward compat | Existing completed runs (workspaceId=NULL) still display correctly in History/ReportDetail |
| Resume | Stale run recovery reads workspace type from run's workspaceId and branches correctly |

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking existing NYT runs | workspaceId is nullable; existing runs keep NULL; all existing queries still work |
| ISBN dedup conflict | Niche signals get synthetic ISBNs (`niche-{slug}-{hash}`) that never collide with real ISBNs |
| stageNicheIngest returns empty | Same error handling as stageIngest: throw if 0 results, caught by withSelfHeal |
| Etsy rate limits in niche ingest | Same 250ms delay pattern already used in Stage 5 Etsy validation |
| Reddit scraping blocked | Use LLM-based analysis (same pattern as forumScraper.ts) — no actual HTTP scraping |

---

## 8. Implementation Order (Phases)

**Phase 1 (Backend foundation):**
1. Migration: add `workspaceId` to `bot_runs`
2. DB helpers: `createRun(workspaceId?)`, `listRunsByWorkspace`, `getLatestRunByWorkspace`
3. Write `stageNicheIngest` function
4. Modify orchestrator signature + branch
5. Modify trigger mutation to accept `workspaceId`
6. Modify `resumePipeline` to be workspace-aware
7. Tests for all above

**Phase 2 (Frontend):**
1. Dashboard/Status: pass `workspaceId` to triggerRun
2. History: filter by workspace
3. Status: dynamic stage labels
4. Reports: workspace-scoped latest report query

---

## 9. Assumptions (Stated Explicitly per Karpathy)

1. The `books` table is reusable for niche signals — we map niche data into the same columns rather than creating a parallel table. This avoids touching Stages 2-7.
2. `stageNicheIngest` uses LLM-based Reddit analysis (same as forumScraper) since actual Reddit API is blocked from Cloud Run.
3. Etsy API calls in `stageNicheIngest` use the same `etsyApiKey` (keystring:shared_secret format) already validated in the pipeline.
4. The `pipelineRunning` flag remains global (only one pipeline run at a time across all workspaces). This is acceptable for now — concurrent workspace runs can be added later if needed.
5. Cross-run trend comparison (`computeCrossRunTrends`) will naturally scope to the same workspace because it compares by ISBN, and niche signals have synthetic ISBNs that won't match NYT books.

---

**Ready for your approval before any code is written.**
