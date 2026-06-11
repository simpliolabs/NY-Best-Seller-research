# Concept page redesign — one live design + version history

**Audience:** Manus (frontend). **Backend is already shipped** (commit on `push-garment-fix`,
`concepts.regenerateImage` rework + `restoreGeneration` + `getGenerationHistory`). This doc is the
frontend spec. Open `concept-page-redesign.html` in a browser for the visual mockup.

Applies to the concept design panel on the book page (e.g. `/pickleball/book/270006`, the
"AI-GENERATED DESIGNS" block) and anywhere the concept's variations are shown.

---

## What changes

Today the panel shows **3 variations** (Clean / Bold / Trending = `imageUrlA/B/C`). After the backend
rework, **regenerate produces ONE best design into slot A** and snapshots the previous design into
history. So the panel becomes:

1. **One live design** — `concept.imageUrlA`, with a green "Live" badge.
2. **A "Previous versions" strip** below it — every past generation, newest first, each with
   **Restore / Edit / Make mockup** actions.

`imageUrlB` / `imageUrlC` are now legacy (regenerate no longer fills them). **Show only slot A.** Do
not render B/C anymore.

---

## Backend API (all on the `concepts` tRPC router — already live)

| Procedure | Type | Input | Returns |
|---|---|---|---|
| `concepts.regenerateImage` | mutation | `{ conceptId: number, style: string }` | `{ success, message }` — makes 1 faithful design into A, snapshots prior A to history |
| `concepts.getGenerationHistory` | query | `{ conceptId: number }` | `DesignRevision[]` (newest first) — the strip data |
| `concepts.restoreGeneration` | mutation | `{ conceptId: number, imageUrl: string }` | `{ success, message }` — snapshots current A, then makes `imageUrl` the live A |

A history row (`DesignRevision`) has: `resultImageUrl` (the design PNG), `instruction` (style label,
e.g. `"Generation — Vintage Engraving"`), `iterationNumber`, `createdAt`.

> History is stored in `design_revisions` under a sentinel `variationKey = "H"`. Do **not** query it
> via `revision.getHistory` (that's for A/B/C edit revisions). Use `concepts.getGenerationHistory`.

---

## Wiring, element by element

### Live design (slot A)
- Image = `concept.imageUrlA`. Badge: "Live" (green). The headline now renders **inside** the art
  (backend prompt fix) — no separate text overlay needed.

### Regenerate control
- Existing style `<select>` + "Regenerate" button → `concepts.regenerateImage.mutate({ conceptId, style })`.
- On success: invalidate `books.getById` (or whatever feeds this concept) **and**
  `concepts.getGenerationHistory` for this `conceptId`. The new design appears live; the old one
  appears in the strip.

### Previous versions strip
- Data: `concepts.getGenerationHistory.useQuery({ conceptId })`.
- **Filter rule:** hide any row where `resultImageUrl === concept.imageUrlA` (that's the live one —
  don't show it twice).
- Empty state (no rows after filter): caption — *"Every regenerate snapshots the prior design here —
  restore, edit, or turn any into a mockup."*
- Each card: the design thumbnail + the `instruction` label + a relative time from `createdAt`, and
  three icon actions:

| Action | Wiring |
|---|---|
| **Restore** (`ti-arrow-back-up`) | `concepts.restoreGeneration.mutate({ conceptId, imageUrl: row.resultImageUrl })`, then invalidate `books.getById` + `getGenerationHistory`. |
| **Edit** (`ti-edit`) | `restoreGeneration` first (makes it slot A), then route to the Design Studio for this concept — the studio edits slot A. |
| **Make mockup** (`ti-shirt`) | `restoreGeneration` first, then the existing mockup-generate flow for this concept. |

> Restore-before-edit/mockup is intentional: the Design Studio and the mockup compositor both operate
> on slot A, so a past version must become live before they can act on it. One extra mutation, no new
> backend.

---

## States
- **Loading:** skeleton for the live design + strip.
- **Regenerating:** disable the Regenerate button + a spinner; the design swaps when the mutation
  resolves.
- **Restoring:** brief disabled state on the clicked card; the live design swaps on resolve.

## Design language
Match the existing app: slate canvas, white rounded cards, 0.5px borders, Tabler outline icons (no
emoji), the green "Live" badge, blue info pill. See `concept-page-redesign.html`.
