# Workspace Architecture Blueprint (Simplified)

**Version:** 7.0 — Karpathy-aligned  
**Status:** Awaiting PO approval  
**Audit applied:** Karpathy Dev Principles + UI/UX Pro Max (v1.0.3)

---

## Design Decisions (Locked)

| Decision | Value | Source |
|---|---|---|
| Typography | Syne (headings) + Manrope (body) | PO + UI/UX Pro Max |
| Accent color | `#22C55E` (green) | UI/UX Pro Max — creative production tool |
| Theme | Dark-first (`#0F172A` background) | UI/UX Pro Max — OLED dark |
| Grouping unit | Trend Pattern (equivalent to Book ID) | PO decision |
| Default images per run | 15 (configurable) | PO decision |
| NYT pipeline | Configurable (same settings panel) | PO decision |
| Niche Hunter | Automated (Etsy + Reddit), manual trigger | PO decision |
| Mockup compositing | Sharp overlay (programmatic, not AI) | PO decision |
| Design revision | GPT Image generation with reference (unlimited) | PO decision |
| Final step | Auto-post to Shopify (not download) | PO decision |
| Pricing | Per size tier within product group | PO decision |
| Per-workspace credentials | Yes (admin UI later, chat for now) | PO decision |

---

## Color System (Complete)

```css
/* Base palette */
--background: #0F172A;
--foreground: #F8FAFC;
--card: #1B2336;
--card-foreground: #F8FAFC;
--muted: #272F42;
--muted-foreground: #94A3B8;
--border: #334155;
--primary: #1E293B;
--primary-foreground: #FFFFFF;
--accent: #22C55E;
--accent-foreground: #0F172A;
--destructive: #EF4444;
--destructive-foreground: #FFFFFF;
--ring: #22C55E;

/* Workflow status colors */
--status-pending: #F59E0B;       /* Amber — awaiting action */
--status-approved: #22C55E;      /* Green — good to go */
--status-rejected: #EF4444;      /* Red — declined */
--status-generating: #3B82F6;    /* Blue — AI working */
--status-designed: #8B5CF6;      /* Purple — ready for review */
--status-accepted: #10B981;      /* Emerald — finalized */
--status-posted: #06B6D4;        /* Cyan — live on Shopify */
```

---

## Typography System

```css
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&family=Syne:wght@400;500;600;700&display=swap');

/* Scale */
--font-heading: 'Syne', sans-serif;
--font-body: 'Manrope', sans-serif;

/* Usage */
Page titles:      Syne 600, 28px
Section headings: Syne 500, 20px
Card titles:      Syne 500, 16px
Body text:        Manrope 400, 14-16px
Labels/badges:    Manrope 500, 12px, uppercase, letter-spacing 0.5px
Data/numbers:     Manrope 600, 14px, tabular-nums
Buttons:          Manrope 600, 14px
```

---

## Architecture: What Changes

### Karpathy Principle Applied: "Minimum code that solves the problem. Nothing speculative."

**REMOVED from original blueprint:**
- ~~`PipelineStage` class interface~~ → plain async function arrays
- ~~`nicheHunterProcedure` type-specific middleware~~ → inline type check in procedure body
- ~~`withSelfHeal` wrapper on every stage~~ → keep only where it already exists
- ~~Full `WorkspaceCredentials` typed interface~~ → simple `getCredential(workspaceId, key)` function
- ~~`/w/:workspaceSlug/` URL prefix~~ → workspace in React context + header only, flat routes
- ~~Re-export shim migration pattern~~ → move code incrementally per phase
- ~~`reorderTemplates` procedure~~ → not requested
- ~~10-state state machine~~ → 6 states (expand when revision phase is built)

---

## Data Model (Simplified)

### New Tables

```sql
-- Phase A: Foundation
CREATE TABLE workspaces (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) NOT NULL UNIQUE,
  icon VARCHAR(10) DEFAULT '🎯',
  workspace_type ENUM('nyt', 'niche_hunter') NOT NULL,
  owner_id VARCHAR(100) NOT NULL,
  niche_profile JSON,
  pipeline_config JSON,
  description_template TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE workspace_credentials (
  id VARCHAR(36) PRIMARY KEY,
  workspace_id VARCHAR(36) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  cred_key VARCHAR(100) NOT NULL,
  cred_value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  UNIQUE(workspace_id, provider, cred_key)
);

-- Phase D: Product Groups
CREATE TABLE product_groups (
  id VARCHAR(36) PRIMARY KEY,
  workspace_id VARCHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  compare_at_price DECIMAL(10,2) NOT NULL,
  print_zone JSON NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE size_pricing_tiers (
  id VARCHAR(36) PRIMARY KEY,
  product_group_id VARCHAR(36) NOT NULL,
  label VARCHAR(50) NOT NULL,
  size_list JSON NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id)
);

CREATE TABLE mockup_templates (
  id VARCHAR(36) PRIMARY KEY,
  product_group_id VARCHAR(36) NOT NULL,
  color_name VARCHAR(50) NOT NULL,
  hex_code VARCHAR(7) NOT NULL,
  image_url TEXT NOT NULL,
  available_sizes JSON NOT NULL,
  sort_order INT DEFAULT 0,
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id)
);

-- Phase E: Niche Hunter
CREATE TABLE trend_patterns (
  id VARCHAR(36) PRIMARY KEY,
  workspace_id VARCHAR(36) NOT NULL,
  scan_id VARCHAR(36),
  source_url TEXT,
  source_platform VARCHAR(20),
  source_title VARCHAR(200),
  source_image_url TEXT,
  source_sales INT,
  pattern_name VARCHAR(200) NOT NULL,
  composition VARCHAR(50),
  color_strategy VARCHAR(50),
  emotional_hook TEXT,
  transferable_pattern TEXT,
  why_it_works TEXT,
  status ENUM('discovered', 'approved', 'dismissed') DEFAULT 'discovered',
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- Phase G: Design Revisions
CREATE TABLE design_revisions (
  id VARCHAR(36) PRIMARY KEY,
  concept_id INT NOT NULL,
  variation_key VARCHAR(1) NOT NULL,
  iteration_number INT NOT NULL DEFAULT 1,
  instruction TEXT NOT NULL,
  reference_image_url TEXT NOT NULL,
  result_image_url TEXT,
  status ENUM('generating', 'complete', 'failed') DEFAULT 'generating',
  accepted BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

-- Phase H: Mockup Renders
CREATE TABLE mockup_renders (
  id VARCHAR(36) PRIMARY KEY,
  concept_id INT NOT NULL,
  template_id VARCHAR(36) NOT NULL,
  image_url TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES mockup_templates(id)
);

-- Phase I: Shopify Products
CREATE TABLE shopify_products (
  id VARCHAR(36) PRIMARY KEY,
  workspace_id VARCHAR(36) NOT NULL,
  concept_id INT NOT NULL,
  shopify_product_id VARCHAR(50),
  shopify_url TEXT,
  title VARCHAR(200) NOT NULL,
  status ENUM('pending', 'posted', 'failed') DEFAULT 'pending',
  variant_count INT DEFAULT 0,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
```

### Existing Table Modifications

```sql
-- Add workspaceId to existing tables (Phase A)
ALTER TABLE books ADD COLUMN workspace_id VARCHAR(36);
ALTER TABLE design_concepts ADD COLUMN workspace_id VARCHAR(36);
ALTER TABLE pipeline_runs ADD COLUMN workspace_id VARCHAR(36);

-- Add concept status for approval workflow (Phase F)
ALTER TABLE design_concepts ADD COLUMN concept_status VARCHAR(20) DEFAULT 'pending';

-- Backfill existing data with default NYT workspace
UPDATE books SET workspace_id = 'ws-nyt-default' WHERE workspace_id IS NULL;
UPDATE design_concepts SET workspace_id = 'ws-nyt-default' WHERE workspace_id IS NULL;
UPDATE pipeline_runs SET workspace_id = 'ws-nyt-default' WHERE workspace_id IS NULL;
```

---

## Server Architecture (Simplified)

### Context Extension (Phase A)

```typescript
// server/_core/context.ts — ADDITION (surgical, 15 lines)

// After user authentication, resolve workspace from header
const workspaceId = req.headers['x-workspace-id'] as string | undefined;
let workspace = null;
if (workspaceId && user) {
  workspace = await getWorkspaceById(workspaceId);
  // Verify user has access
  if (workspace && workspace.ownerId !== user.openId) workspace = null;
}

// Add to context
return { req, res, user, workspace };
```

### Workspace Procedure (Phase A)

```typescript
// server/_core/trpc.ts — ADDITION (surgical, 10 lines)

export const workspaceProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.workspace) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active workspace' });
  }
  return next({ ctx: { ...ctx, workspace: ctx.workspace! } });
});
```

### Credential Access (Phase A)

```typescript
// server/db.ts — ADDITION (simple function, no interface)

export async function getCredential(
  workspaceId: string, 
  provider: string, 
  key: string
): Promise<string | null> {
  const row = await db.select().from(workspaceCredentials)
    .where(and(
      eq(workspaceCredentials.workspaceId, workspaceId),
      eq(workspaceCredentials.provider, provider),
      eq(workspaceCredentials.credKey, key),
    ))
    .limit(1);
  return row[0]?.credValue ?? null;
}
```

### Pipeline Config (Simple JSON, not a class)

```typescript
// shared/types.ts — ADDITION

export interface PipelineConfig {
  topicsPerScan: number;       // Default: 10 (niche_hunter) or 6 (nyt)
  conceptsPerTopic: number;    // Default: 5
  winnersToGenerate: number;   // Default: 5
  variationsPerWinner: number; // Default: 3
}

// Stored as JSON in workspaces.pipeline_config
// Read with: workspace.pipelineConfig ?? DEFAULT_CONFIG
```

### Concept Status (6 states, not 10)

```typescript
// shared/types.ts — ADDITION

export type ConceptStatus = 
  | 'pending'      // Awaiting user approval
  | 'approved'     // Approved, waiting for image generation
  | 'generating'   // Image generation in progress
  | 'designed'     // Images generated, ready for review/revision/acceptance
  | 'accepted'     // Final design accepted, ready for mockup + posting
  | 'posted';      // Posted to Shopify

// Revision is a sub-flow WITHIN 'designed' status, not a separate state.
// When user requests revision: concept stays 'designed', revision record tracks progress.
```

---

## tRPC Procedures (Only What's Needed Per Phase)

### Phase A: Workspace (6 procedures)

```typescript
workspace.list          // → Workspace[]
workspace.getActive     // → Workspace | null
workspace.create        // input: { name, slug, icon, workspaceType } → Workspace
workspace.update        // input: { name?, icon?, pipelineConfig? } → Workspace
workspace.switchTo      // input: { workspaceId } → { success }
workspace.setCredential // input: { provider, credKey, credValue } → { success }
```

### Phase B: Pipeline Config (2 procedures — added to workspace router)

```typescript
workspace.getPipelineConfig   // → PipelineConfig
workspace.updatePipelineConfig // input: PipelineConfig → { success }
```

### Phase C: Onboarding (1 procedure — added to workspace router)

```typescript
workspace.onboardingChat // input: { message, step } → { reply, nicheProfile?, complete }
```

### Phase D: Product Groups (7 procedures)

```typescript
productGroup.list           // → ProductGroup[]
productGroup.create         // input: { name, compareAtPrice, printZone } → ProductGroup
productGroup.update         // input: { id, ...fields } → ProductGroup
productGroup.addPricingTier // input: { productGroupId, label, sizeList, price } → Tier
productGroup.addTemplate    // input: { productGroupId, colorName, hexCode, imageUrl, availableSizes } → Template
productGroup.updateTemplate // input: { templateId, ...fields } → Template
productGroup.deleteTemplate // input: { templateId } → { success }
```

### Phase E: Niche Hunter (5 procedures)

```typescript
nicheHunter.triggerScan    // → { scanId }
nicheHunter.getScanStatus  // input: { scanId? } → { status, progress }
nicheHunter.getPatterns    // input: { status?, limit? } → TrendPattern[]
nicheHunter.approvePattern // input: { patternId } → { success }
nicheHunter.dismissPattern // input: { patternId } → { success }
```

### Phase F: Approval (4 procedures)

```typescript
approval.getPending    // → ConceptWithPattern[]
approval.approve       // input: { conceptId } → { success }
approval.reject        // input: { conceptId } → { success }
approval.batchApprove  // input: { conceptIds[] } → { count }
```

### Phase G: Revision (4 procedures)

```typescript
revision.submit       // input: { conceptId, variationKey, instruction } → { revisionId }
revision.getStatus    // input: { revisionId } → { status, imageUrl? }
revision.getHistory   // input: { conceptId, variationKey } → Revision[]
revision.acceptDesign // input: { conceptId, variationKey, imageUrl } → { success }
```

### Phase H: Mockup (3 procedures)

```typescript
mockup.generate    // input: { conceptId, productGroupId } → { mockupCount }
mockup.getMockups  // input: { conceptId } → MockupRender[]
mockup.regenerate  // input: { mockupId } → { newUrl }
```

### Phase I: Shopify (3 procedures)

```typescript
shopify.postProduct       // input: { conceptId, productGroupId, title? } → { shopifyUrl }
shopify.getProducts       // → ShopifyProduct[]
shopify.getConnectionStatus // → { connected, storeUrl? }
```

**Total: 35 procedures** (down from 45)

---

## Frontend Architecture (Simplified)

### No URL Prefix Change

```
Current:  /dashboard, /library, /status
After:    /dashboard, /library, /status (SAME)

Workspace is context, not URL.
```

### WorkspaceContext (Phase A)

```typescript
// client/src/contexts/WorkspaceContext.tsx

// Stores activeWorkspaceId in localStorage
// Provides: { workspaces, activeWorkspace, switchWorkspace, isLoading }
// Injects X-Workspace-Id header via trpc client modification in main.tsx
```

### DashboardLayout Modification (Phase A)

```
BEFORE:
  Sidebar header: "NYT Design Bot" (hardcoded)
  Nav items: [Dashboard, Analytics, Library, History, Favorites, Run Status, Health]

AFTER:
  Sidebar header: WorkspaceSwitcher dropdown (shows active workspace name + icon)
  Nav items: CONDITIONAL based on workspace.workspaceType
    - 'nyt': [Dashboard, Analytics, Library, History, Favorites, Run Status, Health]
    - 'niche_hunter': [Dashboard, Niche Hunter, Approval, Design Studio, Mockups, 
                       Shopify, Library, Favorites, Runs, Products, Config, Health]
```

### New Pages (Added Per Phase)

| Phase | New Page | Purpose |
|---|---|---|
| B | `PipelineConfig.tsx` | Configure pipeline settings (both workspace types) |
| C | `OnboardingWizard.tsx` | LLM chat-based niche profiling |
| D | `ProductGroups.tsx` | Upload mockup templates, set pricing tiers |
| E | `NicheHunter.tsx` | View discovered patterns, approve/dismiss |
| F | `ApprovalQueue.tsx` | Approve/reject concepts before generation |
| G | `DesignStudio.tsx` | Review designs, submit revision instructions |
| H | `Mockups.tsx` | View mockup renders per concept |
| I | `ShopifyProducts.tsx` | View posted products, post new ones |

---

## Niche Hunter Engine (Phase E)

### Dual Scan — Plain Functions

```typescript
// server/nicheHunter.ts (single file, not a directory of 5 files)

export async function runNicheHunterScan(workspace: Workspace): Promise<TrendPattern[]> {
  // Step 1: Cross-niche scan (Etsy broad categories)
  const hotSellers = await scanEtsyHotSellers(workspace.crossNicheCategories);
  
  // Step 2: In-niche scan (Reddit + Etsy within niche)
  const nicheSignals = await scanInNiche(workspace.inNicheKeywords, workspace.subreddits);
  
  // Step 3: Pattern deconstruction (LLM vision on hot seller images)
  const patterns = await deconstructPatterns(hotSellers);
  
  // Step 4: Adaptation (Pattern × Niche signals → concepts)
  const adapted = await adaptPatterns(patterns, nicheSignals, workspace.nicheProfile);
  
  // Step 5: Saturation check (Etsy white space scoring)
  const scored = await checkSaturation(adapted, workspace.inNicheKeywords);
  
  return scored;
}
```

No class hierarchy. No `PipelineStage` interface. Just functions that call functions.

---

## Mockup Compositor (Phase H)

```typescript
// server/mockupCompositor.ts (single file)

import sharp from 'sharp';

export async function compositeDesignOnMockup(
  designUrl: string,
  mockupUrl: string,
  printZone: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
  const [designBuf, mockupBuf] = await Promise.all([
    downloadImage(designUrl),
    downloadImage(mockupUrl),
  ]);
  
  const mockupMeta = await sharp(mockupBuf).metadata();
  const zoneX = Math.round(printZone.x * mockupMeta.width!);
  const zoneY = Math.round(printZone.y * mockupMeta.height!);
  const zoneW = Math.round(printZone.width * mockupMeta.width!);
  const zoneH = Math.round(printZone.height * mockupMeta.height!);
  
  const resizedDesign = await sharp(designBuf)
    .resize(zoneW, zoneH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  
  const resizedMeta = await sharp(resizedDesign).metadata();
  const offsetX = zoneX + Math.round((zoneW - resizedMeta.width!) / 2);
  const offsetY = zoneY + Math.round((zoneH - resizedMeta.height!) / 2);
  
  return sharp(mockupBuf)
    .composite([{ input: resizedDesign, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();
}
```

---

## Shopify Posting (Phase I)

```typescript
// server/shopifyClient.ts (single file)

export async function postToShopify(
  credentials: { storeUrl: string; accessToken: string },
  product: {
    title: string;
    descriptionHtml: string;
    images: string[];
    variants: Array<{ color: string; size: string; price: number; compareAtPrice: number }>;
  }
): Promise<{ productId: string; url: string }> {
  // Direct Shopify Admin API call
  // Build variant matrix from templates × pricing tiers
  // Upload images
  // Return product URL
}
```

---

## Build Order (9 Phases)

Each phase has explicit **verification criteria** (Karpathy Principle 4):

| Phase | What | Files | Verify |
|---|---|---|---|
| **A** | Foundation | ~7 files modified/created | NYT pipeline still works. Switching shows empty Pickleball state. |
| **B** | Pipeline Config | 2 files | Can change NYT books-per-run from 6→10 and back. Pipeline uses new value. |
| **C** | Onboarding Wizard | 2 files | Chat with LLM produces a niche profile JSON. Stored on workspace. |
| **D** | Product Groups | 3 files | Upload 10 Comfort Colors mockups with pricing tiers. Data persists. |
| **E** | Niche Hunter | 3 files | Trigger scan → finds real Etsy hot sellers → deconstructs patterns → adapts for niche. |
| **F** | Approval Queue | 2 files | Approve 3 concepts → they move to 'approved'. Reject 2 → they disappear from queue. |
| **G** | Design Revision | 3 files | Submit revision instruction → new image generated → can accept or revise again. |
| **H** | Mockup Renderer | 2 files | Accept a design → mockups generated on best N shirt colors → visible in gallery. |
| **I** | Shopify Posting | 2 files | Post product → appears in Shopify store with correct variants and pricing. |

**Total new files: ~26** (down from ~45)  
**Total new procedures: 35** (down from 45)  
**Estimated LOC: ~5,000–6,000** (down from 8,000–10,000)

---

## Migration Strategy (Phase A — Zero Downtime)

1. Create `workspaces` table
2. Insert default NYT workspace: `{ id: 'ws-nyt-default', name: 'NYT Books', slug: 'nyt-books', workspaceType: 'nyt', icon: '📚' }`
3. Add nullable `workspace_id` columns to `books`, `design_concepts`, `pipeline_runs`
4. Backfill all existing rows with `'ws-nyt-default'`
5. Add `WorkspaceContext` to frontend (defaults to NYT workspace)
6. Add `X-Workspace-Id` header to tRPC client
7. Extend `context.ts` to read workspace from header
8. Add `workspaceProcedure` to `trpc.ts`
9. Verify: all existing features work identically

**Existing queries continue working** — they don't filter by workspaceId yet. New workspace-scoped queries are added alongside, not replacing.

---

## Dependencies

| Package | Purpose | Phase | Already installed? |
|---|---|---|---|
| `sharp` | Image compositing for mockups | H | No — `pnpm add sharp` |
| Node `crypto` | Credential encryption (AES-256) | A | Yes (built-in) |

**That's it.** No `@shopify/shopify-api` — we'll use direct `fetch` calls to Shopify Admin API (simpler, fewer dependencies, Karpathy Principle 2).

---

## What This Blueprint Does NOT Specify (Intentionally)

Per Karpathy Principle 2, these are deferred until actually needed:

- ~~Workspace-type-specific procedure middleware~~ → check type inline
- ~~Universal pipeline runner with stage interface~~ → each pipeline is its own function
- ~~Credential typed interface~~ → simple key-value lookup
- ~~URL routing prefix~~ → workspace is context only
- ~~10-state machine~~ → 6 states, expand later
- ~~Re-export shims~~ → move code directly
- ~~Batch reject in approval~~ → add when requested (batch approve stays)
- ~~Template reordering~~ → not requested

---

*This blueprint is complete. It solves the problem with minimum code. Complexity will be added when actually needed, not speculatively.*
