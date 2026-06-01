# Mockups + Product Groups — Workspace Isolation & Workflow Wiring Plan

**Date:** May 30, 2026  
**Status:** Pre-implementation — requires PO approval  
**Principles:** Karpathy Dev (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution)  
**Supporting guidance:** UI/UX Pro Max (product domain: pipeline stage colors + CRM progression; UX domain: step indicators for multi-step processes)

---

## 1. Problem Statement

Two pages — **Mockups** and **Product Groups** — have critical architectural defects that violate workspace data isolation and present a disconnected, confusing workflow to the user.

### 1.1 Defects Identified

| Defect | Location | Impact |
|---|---|---|
| Concept Library query is globally scoped — no `workspaceId` filter | `server/db.ts` → `getAllConcepts()` | Pickleball workspace Mockups dropdown shows NYT concepts ("This Is Fine (Dungeon Edition)" etc.) |
| `library.list` tRPC procedure has no `workspaceId` input | `server/routers.ts` line 503 | Frontend cannot request workspace-scoped concepts |
| Mockups page passes no workspace context to concept query | `client/src/pages/Mockups.tsx` line 32 | Cross-workspace concept selection is possible |
| `mockup.generate` backend has no workspace ownership check | `server/mockupRouter.ts` line 38 | A concept from workspace A can be composited with a product group from workspace B |
| Product Groups page shows groups from other workspaces (the "CC" group) | Unclear if the group was created without workspace assignment | Data leakage between workspaces |
| No workflow connection between pages | All pages are flat sidebar items | User has no guidance on when to use Product Groups vs Mockups vs Design Studio |

### 1.2 Root Cause

The `design_concepts` table has no direct `workspaceId` column. Workspace scoping for concepts is **implicit** through the chain: `design_concepts.runId → bot_runs.workspaceId`. The `getAllConcepts` helper joins `books` and `bot_runs` but never filters on `bot_runs.workspaceId`. This was acceptable when only one workspace existed (NYT), but breaks completely in a multi-workspace environment.

---

## 2. Architectural Decision: How to Scope Concepts

Two options exist:

| Option | Approach | Pros | Cons |
|---|---|---|---|
| **A: Filter via JOIN** | Add `WHERE bot_runs.workspaceId = ?` to `getAllConcepts` | No schema change, no migration, no backfill | Slightly slower query (already joins bot_runs), relies on all concepts having a valid runId |
| **B: Add workspaceId column to design_concepts** | New column + migration + backfill | Direct fast filter, no join needed | Schema change, migration, backfill step, more code touched |

**Decision: Option A (Filter via JOIN).**

Rationale per Karpathy Simplicity First: The join to `bot_runs` already exists in `getAllConcepts`. Adding one WHERE clause is the minimum change. No schema migration needed. All concepts already have a `runId` that maps to a `bot_runs` row with a `workspaceId`. This is a surgical fix.

---

## 3. Wiring Plan — Exact Changes

### 3.1 Backend: `server/db.ts` — `getAllConcepts()`

**Current state:** Accepts filter opts (winnersOnly, format, style, etc.) but no `workspaceId`.

**Change:**
1. Add optional `workspaceId?: string` to the opts type
2. When `workspaceId` is provided, add condition: `eq(botRuns.workspaceId, opts.workspaceId)`
3. The existing `leftJoin(botRuns, ...)` already exists — just add the filter condition

```typescript
// In opts type, add:
workspaceId?: string;

// In conditions array, add:
if (opts.workspaceId) {
  conditions.push(eq(botRuns.workspaceId, opts.workspaceId));
}
```

**Verify:** Query returns only concepts from the specified workspace's runs.

---

### 3.2 Backend: `server/routers.ts` — `library.list` procedure

**Current state:** Input schema has no `workspaceId` field.

**Change:**
1. Add `workspaceId: z.string().optional()` to the input schema
2. Pass it through to `getAllConcepts(input)`

```typescript
list: publicProcedure
  .input(z.object({
    workspaceId: z.string().optional(),  // ← ADD
    limit: z.number().min(1).max(100).default(24),
    // ... rest unchanged
  }))
  .query(async ({ input }) => {
    return getAllConcepts(input);  // workspaceId flows through
  }),
```

**Verify:** Calling `library.list({ workspaceId: "ws-nyt-default" })` returns only NYT concepts; calling with pickleball workspace ID returns only pickleball concepts.

---

### 3.3 Frontend: `client/src/pages/Mockups.tsx` — Pass workspaceId

**Current state:** `trpc.library.list.useQuery({ limit: 100, offset: 0, winnersOnly: true })` — no workspace filter.

**Change:**
```typescript
const conceptsQuery = trpc.library.list.useQuery(
  { limit: 100, offset: 0, winnersOnly: true, workspaceId },  // ← ADD workspaceId
  { enabled: !!workspaceId }
);
```

**Verify:** Pickleball Mockups page shows only Pickleball concepts in the dropdown.

---

### 3.4 Backend: `server/mockupRouter.ts` — Workspace ownership guard

**Current state:** `generate` mutation accepts `conceptId` and `productGroupId` independently with no workspace validation.

**Change:** After loading the concept and product group, verify they belong to the same workspace:

```typescript
// After loading concept (line 48) and group (line 63):
// Get the concept's workspace via its run
const conceptRun = await db.select({ workspaceId: botRuns.workspaceId })
  .from(botRuns)
  .where(eq(botRuns.id, concept.runId))
  .limit(1);
const conceptWorkspaceId = conceptRun[0]?.workspaceId;

// Get the group's workspace
const groupWorkspaceId = group.workspaceId;

if (conceptWorkspaceId && groupWorkspaceId && conceptWorkspaceId !== groupWorkspaceId) {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Concept and product group must belong to the same workspace",
  });
}
```

**Verify:** Attempting to generate a mockup with a cross-workspace concept/group combination returns an error.

---

### 3.5 Frontend: `client/src/pages/ProductGroups.tsx` — Verify workspace scoping

**Current state:** The page already calls `trpc.productGroup.list.useQuery({ workspaceId })` which is correct. The "CC" group appearing in Pickleball likely means it was created with the Pickleball workspace ID (user created it there), or the workspace ID was empty/null.

**Investigation needed:** Check if the "CC" product group has a valid `workspaceId` in the database. If it belongs to the pickleball workspace, that's correct behavior. If it has no workspace or belongs to NYT, that's a data bug.

**Change (if needed):** No code change required if the list query is already workspace-scoped. The "CC" group showing in Pickleball is expected if the user created it there.

---

### 3.6 Frontend: `client/src/pages/Mockups.tsx` — Also scope product groups check

**Current state:** Product groups query already passes `workspaceId`. This is correct. No change needed.

---

## 4. What This Plan Does NOT Do (Scope Lock)

Per Karpathy "No features beyond what was asked" and "Surgical Changes":

| NOT in scope | Reason |
|---|---|
| Redesigning the Mockups page workflow/UX | Not requested — user said "BAD workflow" but the immediate fix is data isolation. Workflow redesign is a separate conversation. |
| Adding concept status progression (approved → mockup_pending → posted) | This is Phase F (Approval State Machine) from the blueprint — not yet built. Separate phase. |
| Adding workspace ownership checks to ALL routers | Only fixing the specific pages the user flagged. |
| Changing the sidebar navigation or adding workflow badges | UX improvement, not a data isolation fix. |
| Adding `workspaceId` column to `design_concepts` table | Option B rejected in favor of simpler JOIN filter. |

---

## 5. Execution Steps (Goal-Driven)

| Step | Action | Verify |
|---|---|---|
| 1 | Add `workspaceId` filter to `getAllConcepts()` in `server/db.ts` | Unit: query with workspaceId returns only that workspace's concepts |
| 2 | Add `workspaceId` to `library.list` input schema in `server/routers.ts` | TypeScript compiles, existing callers still work (field is optional) |
| 3 | Pass `workspaceId` in Mockups.tsx concept query | Pickleball dropdown shows only pickleball concepts |
| 4 | Add workspace ownership guard to `mockup.generate` in `mockupRouter.ts` | Cross-workspace generation throws error |
| 5 | Verify Product Groups "CC" group ownership in DB | Confirm it belongs to pickleball workspace (expected) or fix if orphaned |
| 6 | Run TypeScript check → 0 errors | `npx tsc --noEmit` |
| 7 | Run tests → 103/103 pass | `npx vitest run` |
| 8 | Save checkpoint | `webdev_save_checkpoint` |

---

## 6. Files Touched (Minimal Diff)

| File | Change type | Lines affected |
|---|---|---|
| `server/db.ts` | Edit: add workspaceId to opts + condition | ~3 lines |
| `server/routers.ts` | Edit: add workspaceId to library.list input | ~1 line |
| `client/src/pages/Mockups.tsx` | Edit: pass workspaceId to query | ~1 line |
| `server/mockupRouter.ts` | Edit: add workspace ownership guard | ~10 lines |

**Total: ~15 lines of production code changed across 4 files.**

---

## 7. Risk Assessment

| Risk | Mitigation |
|---|---|
| Existing library.list callers break | `workspaceId` is optional — existing callers without it get global results (backward compatible) |
| Concept Library page shows empty for workspaces with no runs | Expected behavior — workspace has no data yet |
| Performance regression from extra WHERE | Already joining bot_runs; adding one equality check is negligible |
| "CC" product group is orphaned data | Will verify in DB before touching |

---

## 8. Supporting UI/UX Pro Max Guidance

### Project Source of Truth

> The architecture blueprint (Section 13.3) states: "Every query that returns workspace-scoped data MUST include a `WHERE workspaceId = ?` clause."

### Supporting UI/UX Pro Max Guidance

- Query: `product: multi-step production pipeline workflow UX`
- Relevant result: CRM/Pipeline pattern recommends "pipeline stage colors + closed-won green" for status progression
- Decision: Not implementing status progression in this fix (scope lock), but noting for future Phase F Approval State Machine work

- Query: `ux: workspace-scoped data isolation multi-tenant dashboard`
- Relevant result: "Show progress for multi-step processes — step indicators or progress bar"
- Decision: Current pipeline Status page already has step indicators. Mockups/Product Groups don't need them yet — they're utility pages, not workflow stages.

---

## 9. Approval Gate

**This plan requires PO approval before any code is written.**

Changes are minimal (15 lines), surgical, and backward-compatible. No schema migrations. No new dependencies. No UX redesign.
