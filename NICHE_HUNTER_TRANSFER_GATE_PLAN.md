# Niche Hunter: Source Link + Cross-Niche Transfer Validation Gate
## Architecture Plan — Karpathy Principles Applied

---

## Problem Statement

The Niche Hunter currently surfaces ALL adapted patterns regardless of whether the core pun, wordplay, or emotional hook actually survives the niche transfer. "Reel Cool Dinker" with a fishing rod is a fishing pun — the word "reel" only works because fishing reels exist. When adapted to pickleball, the pun is dead. The design should never be shown unless the wordplay is re-anchored to pickleball vocabulary ("Real Cool Dinker — Because Dinking IS an Art").

**Rule:** If the hook is source-niche-locked AND cannot be re-anchored → auto-dismiss before the UI ever sees it.

---

## Two Features in Scope

| Feature | Description |
|---------|-------------|
| **Source Link** | Each card shows "Inspired by: [source title] on Etsy →" linking to an Etsy search for that title |
| **Transfer Validation Gate** | LLM checks pun/hook transfer fitness; auto-dismisses failures; re-anchors where possible |

---

## Data Model Changes

### `trend_patterns` table — 3 new fields

```ts
sourceCategory: varchar("sourceCategory", { length: 100 }),   // e.g. "Fishing", "Yoga Cats"
transferValid:  boolean("transferValid").default(true),        // false = auto-dismissed
transferReasoning: text("transferReasoning"),                  // why it passed/failed
```

**Migration:** `ALTER TABLE trend_patterns ADD COLUMN sourceCategory VARCHAR(100), ADD COLUMN transferValid BOOLEAN DEFAULT TRUE, ADD COLUMN transferReasoning TEXT;`

No existing rows are affected — `transferValid` defaults to `true` so old patterns remain visible.

---

## Backend Changes

### 1. `server/nicheHunter.ts` — `deconstructAndAdapt()`

**Current flow:**
```
hotSellers + nicheSignals → LLM → DeconstructedPattern[]
```

**New flow:**
```
hotSellers + nicheSignals → LLM (deconstruct + adapt + validate transfer) → ValidatedPattern[]
```

The single LLM call is extended to also return:
- `sourceCategory: string` — the source niche category (from `hotSeller.category`)
- `transferValid: boolean` — does the hook survive the niche transfer?
- `transferReasoning: string` — one sentence explaining why it passed or failed
- `adaptedConcept: string` — if `transferValid=false` but re-anchor is possible, this field contains the re-anchored concept; otherwise the original adapted concept

**Prompt addition to `deconstructAndAdapt` system message:**

```
TRANSFER VALIDATION RULE (HARD CONSTRAINT):
After adapting each concept, evaluate whether the core pun, wordplay, or emotional hook
actually works in the TARGET niche — not just the source niche.

Ask: "Does this joke/pun/hook make sense WITHOUT knowing the source niche?"
- If YES → transferValid: true
- If NO but can be re-anchored to target niche vocabulary → rewrite adaptedConcept with
  the re-anchored version, set transferValid: true, explain in transferReasoning
- If NO and cannot be re-anchored meaningfully → transferValid: false, explain in transferReasoning

Example:
- Source: "Reel Cool Dinker" (fishing pun — "reel" = fishing reel)
- Naive adaptation: "Reel Cool Dinker" with a fishing rod on a pickleball shirt → INVALID
  (pun only works in fishing context)
- Re-anchored: "Real Cool Dinker — Because Dinking IS an Art" → VALID
  (re-anchors to pickleball vocabulary, pun replaced with niche-specific pride)
```

**JSON schema addition:**
```json
"sourceCategory": { "type": "string" },
"transferValid": { "type": "boolean" },
"transferReasoning": { "type": "string" }
```

### 2. `server/nicheHunter.ts` — `runNicheHunterScan()`

After `createTrendPattern`, persist the new fields:
```ts
sourceCategory: hotSeller?.category ?? null,
transferValid: p.transferValid ?? true,
transferReasoning: p.transferReasoning ?? null,
```

**Auto-dismiss gate:** After `createTrendPattern`, if `p.transferValid === false`:
```ts
await updateTrendPatternStatus(row.id, "dismissed");
// Skip image generation — no point generating image for dismissed pattern
continue;
```

This means `transferValid=false` patterns are dismissed at creation time, before image gen runs. They never appear in the UI under any tab except "Dismissed" (where they can be manually reviewed and re-approved if desired).

### 3. `server/nicheHunterDb.ts` — No change needed

`getTrendPatternsByWorkspace(workspaceId, "discovered")` already filters by status. Since we auto-dismiss at creation, no additional filter is needed.

---

## Frontend Changes

### 4. `client/src/pages/NicheHunter.tsx` — Source link + sourceCategory badge

Each pattern card gets two additions:

**Source link** (below the source title line):
```tsx
{pattern.sourceTitle && (
  <a
    href={`https://www.etsy.com/search?q=${encodeURIComponent(
      pattern.sourceTitle.split(" ").slice(0, 4).join(" ")
    )}`}
    target="_blank"
    rel="noopener noreferrer"
    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mt-0.5"
  >
    <ExternalLink className="w-3 h-3" />
    View on Etsy
  </a>
)}
```

**Source category badge** (next to the platform badge):
```tsx
{pattern.sourceCategory && (
  <Badge variant="outline" className="text-xs">
    From: {pattern.sourceCategory}
  </Badge>
)}
```

This gives the user instant context: "This pattern came from the Fishing niche."

### 5. `shared/types.ts` or tRPC return type — Add new fields

The `TrendPattern` type already comes from Drizzle inference. The new fields are automatically included once the schema migration runs. No manual type update needed.

---

## File Change Summary

| File | Change | Lines |
|------|--------|-------|
| `drizzle/schema.ts` | Add `sourceCategory`, `transferValid`, `transferReasoning` to `trendPatterns` | +6 |
| `server/nicheHunter.ts` | Extend `DeconstructedPattern` type + LLM prompt + auto-dismiss gate | +35 |
| `server/nicheHunterRouter.ts` | Expose `sourceCategory`, `transferValid`, `transferReasoning` in list response | +3 |
| `client/src/pages/NicheHunter.tsx` | Add source link + sourceCategory badge to each card | +15 |
| Migration SQL | `ALTER TABLE trend_patterns ADD COLUMN ...` | 1 statement |

**Total: ~60 lines across 5 files. Zero new tables. Zero new routes.**

---

## Scope Lock (Karpathy)

**In scope:** Schema fields, LLM prompt extension, auto-dismiss gate, source link display, sourceCategory badge.

**Out of scope:** Retroactively re-validating existing patterns (they keep `transferValid=true` default), UI for manually re-anchoring dismissed patterns (future), Etsy API integration for real listing URLs (future — we use search URL constructed from title keywords).

---

## Graceful Degradation

- If `transferValid` field is null (old rows) → treated as `true`, shown normally
- If Etsy search URL construction fails → link simply not shown
- If LLM omits `transferValid` field → defaults to `true` (safe, not auto-dismissed)
