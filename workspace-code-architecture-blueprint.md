# Workspace System — Full Code Architecture Blueprint

**Date:** May 29, 2026  
**Status:** Pre-implementation — requires PO approval  
**Companion to:** workspace-architecture-FINAL-v6.md (product spec)  
**Purpose:** Maps every file, module, contract, state machine, and wiring point at implementation level.

---

## Table of Contents

1. [Current Codebase Anatomy](#1-current-codebase-anatomy)
2. [Target File Tree (After All Phases)](#2-target-file-tree)
3. [Database Schema — Full DDL](#3-database-schema)
4. [Server Module Architecture](#4-server-module-architecture)
5. [tRPC Router Contracts (Full API Surface)](#5-trpc-router-contracts)
6. [Pipeline Orchestrator Refactor](#6-pipeline-orchestrator-refactor)
7. [Niche Hunter Engine](#7-niche-hunter-engine)
8. [Approval State Machine](#8-approval-state-machine)
9. [Design Revision Engine](#9-design-revision-engine)
10. [Mockup Compositor](#10-mockup-compositor)
11. [Shopify Integration](#11-shopify-integration)
12. [Frontend Architecture](#12-frontend-architecture)
13. [Workspace Context & Routing](#13-workspace-context-and-routing)
14. [Migration Strategy (NYT Backward Compat)](#14-migration-strategy)
15. [Testing Strategy](#15-testing-strategy)
16. [Dependency Additions](#16-dependency-additions)

---

## 1. Current Codebase Anatomy

### 1.1 Server Modules (Today)

| File | Lines | Responsibility | Exported Functions |
|---|---|---|---|
| `server/routers.ts` | 622 | All tRPC procedures (auth, pipeline, reports, books, favorites, library, analytics, concepts, health) | `appRouter` |
| `server/db.ts` | 1209 | 57 query helpers (all NYT-specific) | `getDb`, `upsertBooksByIsbn`, `getAllConcepts`, etc. |
| `server/pipeline.ts` | ~900 | 7-stage NYT pipeline orchestrator + all LLM prompts | `runPipeline`, `recoverStaleRuns`, `regenerateImagesForRun`, `stageWorldBible` |
| `server/bookRefresh.ts` | ~280 | Per-book mini-pipeline (forum + world bible + concepts) | `refreshBook`, `getRefreshStatus` |
| `server/forumScraper.ts` | ~490 | Reddit, Goodreads, StoryGraph, Fable, BookRiot scrapers | `scrapeAllForums`, `computeForumScore`, `extractCrossSourceSignals` |
| `server/selfHeal.ts` | ~420 | Circuit breaker, retry, health checks | `withSelfHeal`, `withCircuitBreaker`, `checkHealth` |
| `server/storage.ts` | ~90 | S3 upload/download helpers | `storagePut`, `storageGet` |

### 1.2 Client Pages (Today)

| File | Purpose |
|---|---|
| `Home.tsx` | Landing / Dashboard with winning concepts |
| `Analytics.tsx` | Book analysis metrics |
| `ConceptLibrary.tsx` | All 30 concepts grid |
| `ReportHistory.tsx` | Past run reports |
| `Favorites.tsx` | Saved concepts |
| `Status.tsx` | Run Status (7-stage progress) |
| `BookDetail.tsx` | Book detail + World Bible + niche research |
| `SystemHealth.tsx` | Pipeline health |

### 1.3 Key Architectural Facts

- **Single Express process** — one `server/_core/index.ts` bootstraps everything
- **Single tRPC mount** at `/api/trpc` — all API through one router
- **No workspace awareness** — all data is global, no tenant isolation
- **Pipeline is monolithic** — `runPipeline()` is one function with 7 sequential stages
- **All prompts inline** — LLM system prompts are const strings in `pipeline.ts`
- **Context has no workspace** — `ctx = { req, res, user }` only
- **No background job queue** — pipeline runs as fire-and-forget Promise
- **BrowserScraper** — client-side component participates in pipeline enrichment

---

## 2. Target File Tree (After All Phases)

```
server/
├── _core/                          # Framework (DO NOT TOUCH)
│   ├── index.ts                    # Express bootstrap
│   ├── context.ts                  # tRPC context builder ← MODIFIED (add workspace)
│   ├── trpc.ts                     # Procedure builders ← MODIFIED (add workspaceProcedure)
│   ├── env.ts                      # Environment vars
│   ├── llm.ts                      # LLM helper
│   ├── imageGeneration.ts          # Image gen helper
│   ├── notification.ts             # Owner notification
│   └── ...
│
├── routers/                        # ← NEW: Split routers by domain
│   ├── index.ts                    # Merges all sub-routers into appRouter
│   ├── auth.router.ts              # Auth procedures (existing)
│   ├── pipeline.router.ts          # Pipeline trigger/status (existing, workspace-scoped)
│   ├── workspace.router.ts         # ← NEW: CRUD workspaces, switch, config
│   ├── nicheHunter.router.ts       # ← NEW: Trigger scan, get results
│   ├── approval.router.ts          # ← NEW: Approve/reject, batch actions
│   ├── revision.router.ts          # ← NEW: Submit revision, accept design
│   ├── mockup.router.ts            # ← NEW: Trigger renders, get results
│   ├── shopify.router.ts           # ← NEW: Post product, get status
│   ├── productGroup.router.ts      # ← NEW: CRUD product groups + templates
│   ├── library.router.ts           # Library/favorites (existing, workspace-scoped)
│   ├── reports.router.ts           # Report history (existing, workspace-scoped)
│   ├── books.router.ts             # Book queries (existing, workspace-scoped)
│   ├── analytics.router.ts         # Analytics (existing, workspace-scoped)
│   └── health.router.ts            # System health (existing)
│
├── db/                             # ← NEW: Split db by domain
│   ├── index.ts                    # getDb() + shared connection
│   ├── workspace.db.ts             # Workspace CRUD
│   ├── trendPattern.db.ts          # Trend pattern CRUD
│   ├── concept.db.ts               # Design concept queries (existing logic moved)
│   ├── book.db.ts                  # Book queries (existing logic moved)
│   ├── run.db.ts                   # Pipeline run queries (existing logic moved)
│   ├── nicheResearch.db.ts         # Niche research (existing logic moved)
│   ├── marketValidation.db.ts      # Market validation (existing logic moved)
│   ├── productGroup.db.ts          # Product group + templates + pricing
│   ├── revision.db.ts              # Design revision history
│   ├── mockup.db.ts                # Mockup render records
│   ├── shopify.db.ts               # Shopify product records
│   └── credential.db.ts            # Per-workspace encrypted credentials
│
├── engines/                        # ← NEW: Business logic engines
│   ├── nicheHunter/
│   │   ├── index.ts                # Orchestrator: dual scan → adaptation
│   │   ├── crossNicheScan.ts       # Etsy broad category scanner
│   │   ├── inNicheScan.ts          # Reddit + Etsy niche scanner
│   │   ├── patternDeconstructor.ts # LLM vision: image → pattern description
│   │   ├── adaptationEngine.ts     # LLM: pattern × niche → concepts
│   │   └── prompts.ts              # All Niche Hunter LLM prompts
│   │
│   ├── pipeline/
│   │   ├── index.ts                # Universal pipeline orchestrator (refactored)
│   │   ├── nytDiscovery.ts         # NYT API fetch (extracted from current pipeline.ts)
│   │   ├── forumScraper.ts         # Moved from server/forumScraper.ts
│   │   ├── nicheResearch.ts        # Extracted niche research stage
│   │   ├── conceptGeneration.ts    # Extracted concept gen stage
│   │   ├── scoring.ts              # Extracted scoring stage
│   │   ├── imageGeneration.ts      # Extracted image gen stage (10-layer formula)
│   │   ├── worldBible.ts           # Extracted World Bible stage
│   │   ├── reporting.ts            # Extracted report stage
│   │   └── prompts.ts              # All pipeline LLM prompts (moved from pipeline.ts)
│   │
│   ├── revision/
│   │   ├── index.ts                # Revision loop orchestrator
│   │   └── prompts.ts              # Revision instruction → image gen prompt
│   │
│   ├── mockup/
│   │   ├── index.ts                # Mockup compositor orchestrator
│   │   ├── colorMatcher.ts         # LLM picks best N colors for design
│   │   └── compositor.ts           # Sharp overlay logic
│   │
│   └── shopify/
│       ├── index.ts                # Shopify posting orchestrator
│       ├── variantBuilder.ts       # Color × Size × Price matrix
│       ├── titleGenerator.ts       # LLM short title generation
│       └── api.ts                  # Shopify Admin API client
│
├── middleware/
│   ├── workspaceResolver.ts        # ← NEW: Resolves workspace from context
│   └── credentialLoader.ts         # ← NEW: Loads workspace credentials into context
│
├── storage.ts                      # Existing S3 helpers (unchanged)
├── selfHeal.ts                     # Existing self-heal (unchanged)
│
├── db.ts                           # ← DEPRECATED: Kept for backward compat during migration
├── pipeline.ts                     # ← DEPRECATED: Kept as re-export shim during migration
├── routers.ts                      # ← DEPRECATED: Replaced by routers/index.ts
├── forumScraper.ts                 # ← DEPRECATED: Moved to engines/pipeline/
└── bookRefresh.ts                  # ← DEPRECATED: Absorbed into engines/pipeline/

client/src/
├── contexts/
│   ├── AuthContext.tsx             # Existing
│   └── WorkspaceContext.tsx        # ← NEW: Active workspace state + switcher
│
├── pages/
│   ├── workspace/                  # ← NEW: Workspace-scoped pages
│   │   ├── Dashboard.tsx           # Universal dashboard (adapts to workspace type)
│   │   ├── NicheHunter.tsx         # ← NEW: Scan results + "Run Now"
│   │   ├── ApprovalQueue.tsx       # ← NEW: Approve/reject concepts
│   │   ├── DesignStudio.tsx        # ← NEW: Review + revise designs
│   │   ├── Mockups.tsx             # ← NEW: Generated mockups gallery
│   │   ├── ShopifyProducts.tsx     # ← NEW: Posted products list
│   │   ├── ConceptLibrary.tsx      # Existing (workspace-filtered)
│   │   ├── Favorites.tsx           # Existing (workspace-filtered)
│   │   ├── RunHistory.tsx          # Existing (workspace-filtered)
│   │   ├── PipelineConfig.tsx      # ← NEW: Configurable settings
│   │   ├── ProductGroups.tsx       # ← NEW: Manage mockup templates
│   │   ├── BookDetail.tsx          # Existing (NYT workspace only)
│   │   ├── Status.tsx              # Existing (workspace-filtered)
│   │   ├── Analytics.tsx           # Existing (workspace-filtered)
│   │   └── SystemHealth.tsx        # Existing
│   │
│   ├── onboarding/                 # ← NEW: Workspace creation wizard
│   │   ├── OnboardingWizard.tsx    # 3-step chat-style wizard
│   │   ├── NicheProfileStep.tsx    # LLM conversation
│   │   ├── ResearchConfigStep.tsx  # Categories, subreddits, keywords
│   │   └── ProductSetupStep.tsx    # Upload mockups (optional)
│   │
│   └── Home.tsx                    # Redirect to active workspace dashboard
│
├── components/
│   ├── WorkspaceSwitcher.tsx       # ← NEW: Dropdown at top of sidebar
│   ├── ApprovalCard.tsx            # ← NEW: Concept approval card
│   ├── RevisionPanel.tsx           # ← NEW: Side-by-side revision UI
│   ├── MockupGallery.tsx           # ← NEW: Color variant grid
│   ├── PatternCard.tsx             # ← NEW: Discovered pattern display
│   ├── PipelineConfigForm.tsx      # ← NEW: Settings form
│   ├── ProductGroupEditor.tsx      # ← NEW: Upload + pricing UI
│   ├── DashboardLayout.tsx         # MODIFIED: Workspace-aware sidebar
│   ├── NicheResearchPanel.tsx      # Existing
│   ├── ImageLightbox.tsx           # Existing
│   └── BrowserScraper.tsx          # Existing (NYT workspace only)
│
├── hooks/
│   ├── useWorkspace.ts             # ← NEW: Active workspace hook
│   └── useAuth.ts                  # Existing (from _core)
│
└── App.tsx                         # MODIFIED: Workspace-aware routing

drizzle/
├── schema.ts                       # MODIFIED: New tables + workspaceId columns
└── 0013_*.sql                      # Migration: workspace foundation
└── 0014_*.sql                      # Migration: niche hunter tables
└── 0015_*.sql                      # Migration: product groups
└── ...

shared/
├── types.ts                        # MODIFIED: Workspace types, pipeline config types
└── const.ts                        # Existing
```

---

## 3. Database Schema — Full DDL

### 3.1 New Tables

```sql
-- ═══════════════════════════════════════════════════════════════
-- TABLE: workspaces
-- Purpose: Top-level tenant isolation unit
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE workspaces (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  icon VARCHAR(10) DEFAULT '📦',
  workspaceType ENUM('nyt', 'niche_hunter') NOT NULL DEFAULT 'niche_hunter',
  
  -- LLM-generated niche profile (from onboarding wizard)
  nicheProfile JSON COMMENT 'audience demographics, tone, interests, cultural refs',
  
  -- Site-wide Shopify description template
  descriptionTemplate TEXT,
  
  -- Pipeline configuration (universal settings)
  pipelineConfig JSON NOT NULL DEFAULT (JSON_OBJECT(
    'topicsPerScan', 5,
    'conceptsPerTopic', 5,
    'approvalMode', 'auto',
    'winnersToGenerate', 5,
    'variationsPerWinner', 3
  )),
  
  -- Niche Hunter configuration (niche_hunter type only)
  crossNicheCategories JSON COMMENT '["funny shirt", "animal tee", ...]',
  inNicheKeywords JSON COMMENT '["pickleball", "dinking", ...]',
  subreddits JSON COMMENT '["r/pickleball", "r/10s", ...]',
  
  -- Sales threshold for cross-niche scan
  minSalesThreshold INT DEFAULT 500,
  recencyMonths INT DEFAULT 6,
  
  status ENUM('setup', 'active', 'paused') NOT NULL DEFAULT 'setup',
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: workspace_credentials
-- Purpose: Per-workspace API keys (encrypted at rest)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE workspace_credentials (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  provider ENUM('shopify', 'etsy', 'reddit', 'custom') NOT NULL,
  credKey VARCHAR(100) NOT NULL,
  credValue TEXT NOT NULL COMMENT 'AES-256 encrypted',
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  UNIQUE KEY uq_ws_cred (workspaceId, credKey),
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: trend_patterns
-- Purpose: Discovered design patterns (≡ Books in NYT)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE trend_patterns (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  runId INT COMMENT 'FK to bot_runs.id for the scan that found this',
  
  -- Source pattern data (from cross-niche scan)
  patternName VARCHAR(255) NOT NULL,
  sourceUrl TEXT,
  sourceSeller VARCHAR(255),
  sourceImageUrl TEXT,
  salesCount INT,
  salesVelocity FLOAT COMMENT 'sales per day',
  composition VARCHAR(100) COMMENT 'silhouette, badge, typography, illustration',
  emotionalHook VARCHAR(255),
  colorStrategy VARCHAR(100) COMMENT 'single-color, duotone, full-color',
  transferablePattern TEXT COMMENT 'LLM description of what makes it work',
  
  -- In-niche research data
  inNicheResearch JSON COMMENT 'phrases, jokes, cultural moments, saturation',
  
  -- Adaptation profile (how to adapt for this workspace niche)
  adaptationProfile JSON COMMENT 'subject swaps, phrase anchors, style lens',
  
  -- World Bible equivalent for niche patterns
  worldBible JSON COMMENT 'visual environments, objects, lighting, texture',
  
  -- Status flow: discovered → approved → generating → complete → dismissed
  status ENUM('discovered', 'approved', 'generating', 'complete', 'dismissed') 
    NOT NULL DEFAULT 'discovered',
  
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  INDEX idx_tp_workspace_status (workspaceId, status)
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: product_groups
-- Purpose: Mockup template groups with pricing tiers
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE product_groups (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL COMMENT 'e.g., Comfort Colors 1717',
  compareAtPrice DECIMAL(10,2) COMMENT 'Strikethrough price, e.g., 49.95',
  
  -- Print zone definition (relative coordinates on mockup image)
  printZone JSON NOT NULL DEFAULT (JSON_OBJECT(
    'x', 0.25,
    'y', 0.15,
    'width', 0.50,
    'height', 0.45
  )) COMMENT '{ x, y, width, height } as ratios 0-1',
  
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: size_pricing_tiers
-- Purpose: Per-size-range pricing within a product group
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE size_pricing_tiers (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  productGroupId VARCHAR(36) NOT NULL,
  label VARCHAR(50) NOT NULL COMMENT 'e.g., S-XL, 2XL, 3XL+',
  sizeList JSON NOT NULL COMMENT '["S","M","L","XL"]',
  price DECIMAL(10,2) NOT NULL COMMENT 'Sale price for this tier',
  sortOrder INT NOT NULL DEFAULT 0,
  FOREIGN KEY (productGroupId) REFERENCES product_groups(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: mockup_templates
-- Purpose: Blank product photos per color
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE mockup_templates (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  productGroupId VARCHAR(36) NOT NULL,
  colorName VARCHAR(100) NOT NULL COMMENT 'e.g., Butter',
  hexCode VARCHAR(7) NOT NULL COMMENT 'e.g., #F5E6A3',
  imageUrl TEXT NOT NULL COMMENT 'S3 URL of blank shirt photo',
  availableSizes JSON NOT NULL COMMENT '["S","M","L","XL","2XL","3XL"]',
  sortOrder INT NOT NULL DEFAULT 0,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (productGroupId) REFERENCES product_groups(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: design_revisions
-- Purpose: Iteration history for design revision loop
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE design_revisions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  conceptId INT NOT NULL COMMENT 'FK to design_concepts.id',
  variationKey VARCHAR(1) NOT NULL COMMENT 'A, B, or C',
  iterationNumber INT NOT NULL DEFAULT 1,
  instruction TEXT COMMENT 'User revision instruction text',
  referenceImageUrl TEXT COMMENT 'Image used as reference for generation',
  resultImageUrl TEXT NOT NULL COMMENT 'Generated result image URL',
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  createdAt BIGINT NOT NULL,
  INDEX idx_dr_concept (conceptId, variationKey)
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: mockup_renders
-- Purpose: Composited design-on-shirt images
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE mockup_renders (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  conceptId INT NOT NULL,
  variationKey VARCHAR(1) NOT NULL,
  templateId VARCHAR(36) NOT NULL COMMENT 'FK to mockup_templates.id',
  compositeUrl TEXT NOT NULL COMMENT 'S3 URL of final composite',
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (templateId) REFERENCES mockup_templates(id) ON DELETE CASCADE,
  INDEX idx_mr_concept (conceptId, variationKey)
);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: shopify_products
-- Purpose: Posted product records
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE shopify_products (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  conceptId INT NOT NULL,
  shopifyProductId VARCHAR(100) COMMENT 'Shopify internal product ID',
  shopifyHandle VARCHAR(255) COMMENT 'URL slug on Shopify',
  title VARCHAR(255) NOT NULL,
  variantCount INT,
  status ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'active',
  shopifyUrl TEXT COMMENT 'Full product URL',
  publishedAt BIGINT,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  INDEX idx_sp_workspace (workspaceId, status)
);
```

### 3.2 Columns Added to Existing Tables

```sql
-- Add workspace isolation to all existing tables
ALTER TABLE bot_runs ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;
ALTER TABLE books ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;
ALTER TABLE design_concepts ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;
ALTER TABLE design_concepts ADD COLUMN trendPatternId VARCHAR(36) DEFAULT NULL;
ALTER TABLE design_concepts ADD COLUMN approvalStatus ENUM('pending','approved','rejected') DEFAULT 'approved';
ALTER TABLE design_concepts ADD COLUMN acceptedVariation VARCHAR(1) DEFAULT NULL;
ALTER TABLE design_concepts ADD COLUMN acceptedImageUrl TEXT DEFAULT NULL;
ALTER TABLE niche_research ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;
ALTER TABLE market_validation ADD COLUMN workspaceId VARCHAR(36) DEFAULT NULL;

-- Create default NYT workspace and backfill
INSERT INTO workspaces (id, name, slug, icon, workspaceType, status, pipelineConfig, createdAt, updatedAt)
VALUES ('ws-nyt-default', 'NYT Books', 'nyt-books', '📚', 'nyt', 'active', 
  JSON_OBJECT('topicsPerScan', 6, 'conceptsPerTopic', 5, 'approvalMode', 'auto', 
              'winnersToGenerate', 5, 'variationsPerWinner', 3),
  UNIX_TIMESTAMP()*1000, UNIX_TIMESTAMP()*1000);

-- Backfill existing data with default workspace
UPDATE bot_runs SET workspaceId = 'ws-nyt-default' WHERE workspaceId IS NULL;
UPDATE books SET workspaceId = 'ws-nyt-default' WHERE workspaceId IS NULL;
UPDATE design_concepts SET workspaceId = 'ws-nyt-default' WHERE workspaceId IS NULL;
UPDATE niche_research SET workspaceId = 'ws-nyt-default' WHERE workspaceId IS NULL;
UPDATE market_validation SET workspaceId = 'ws-nyt-default' WHERE workspaceId IS NULL;
```

---

## 4. Server Module Architecture

### 4.1 Context Extension

```typescript
// server/_core/context.ts — MODIFIED
export interface TrpcContext {
  req: Request;
  res: Response;
  user: User | null;
  workspace: Workspace | null;  // ← NEW: resolved from header/cookie/URL
}
```

### 4.2 Workspace Resolution Strategy

```typescript
// server/middleware/workspaceResolver.ts
// Priority order for resolving active workspace:
// 1. X-Workspace-Id header (API calls)
// 2. ?workspace= query param (deep links)
// 3. user.lastWorkspaceId (stored preference)
// 4. First workspace in user's list (fallback)

export async function resolveWorkspace(req: Request, user: User | null): Promise<Workspace | null> {
  if (!user) return null;
  
  const headerWs = req.headers['x-workspace-id'] as string;
  if (headerWs) return getWorkspaceById(headerWs);
  
  const queryWs = req.query.workspace as string;
  if (queryWs) return getWorkspaceBySlug(queryWs);
  
  // Fallback: user's last active workspace
  return getDefaultWorkspaceForUser(user.id);
}
```

### 4.3 Procedure Builders

```typescript
// server/_core/trpc.ts — ADDITIONS

// Workspace-scoped procedure (requires auth + active workspace)
export const workspaceProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.workspace) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No active workspace' });
  }
  return next({ ctx: { ...ctx, workspace: ctx.workspace } });
});

// Workspace-type-specific procedures
export const nicheHunterProcedure = workspaceProcedure.use(({ ctx, next }) => {
  if (ctx.workspace.workspaceType !== 'niche_hunter') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Feature not available for this workspace type' });
  }
  return next({ ctx });
});
```

### 4.4 Credential Loading

```typescript
// server/middleware/credentialLoader.ts
// Decrypts and injects workspace-specific API keys into a request-scoped config object

export interface WorkspaceCredentials {
  shopify?: { storeUrl: string; accessToken: string };
  etsy?: { apiKey: string; apiSecret?: string };
  reddit?: { clientId: string; clientSecret: string };
}

export async function loadCredentials(workspaceId: string): Promise<WorkspaceCredentials> {
  const rows = await getCredentialsByWorkspace(workspaceId);
  const decrypted = rows.map(r => ({ ...r, credValue: decrypt(r.credValue) }));
  // ... group by provider and return structured object
}
```

---

## 5. tRPC Router Contracts (Full API Surface)

### 5.1 workspace.router.ts

```typescript
workspace: router({
  // List all workspaces for current user
  list: protectedProcedure.query() → Workspace[]
  
  // Get active workspace details
  getActive: workspaceProcedure.query() → WorkspaceWithConfig
  
  // Create new workspace (starts onboarding)
  create: protectedProcedure
    .input({ name, slug, icon, workspaceType })
    .mutation() → Workspace
  
  // Update workspace settings
  update: workspaceProcedure
    .input({ name?, icon?, nicheProfile?, descriptionTemplate?, 
             crossNicheCategories?, inNicheKeywords?, subreddits?,
             minSalesThreshold?, recencyMonths? })
    .mutation() → Workspace
  
  // Update pipeline configuration
  updatePipelineConfig: workspaceProcedure
    .input({ topicsPerScan?, conceptsPerTopic?, approvalMode?, 
             winnersToGenerate?, variationsPerWinner? })
    .mutation() → PipelineConfig
  
  // Switch active workspace
  switchTo: protectedProcedure
    .input({ workspaceId })
    .mutation() → { success: true }
  
  // Store credential (encrypted)
  setCredential: workspaceProcedure
    .input({ provider, credKey, credValue })
    .mutation() → { success: true }
  
  // Onboarding: LLM niche profiling conversation
  onboardingChat: workspaceProcedure
    .input({ message: string, step: number })
    .mutation() → { reply: string, nicheProfile?: JSON, complete: boolean }
})
```

### 5.2 nicheHunter.router.ts

```typescript
nicheHunter: router({
  // Trigger a new Niche Hunter scan
  triggerScan: nicheHunterProcedure.mutation() → { success, scanId }
  
  // Get scan status (polling)
  getScanStatus: nicheHunterProcedure
    .input({ scanId? })
    .query() → { status, progress, patternsFound, currentStep }
  
  // Get discovered patterns from latest scan
  getPatterns: nicheHunterProcedure
    .input({ status?: 'discovered' | 'approved' | 'dismissed', limit?, offset? })
    .query() → TrendPattern[]
  
  // Get single pattern with full detail
  getPatternById: nicheHunterProcedure
    .input({ patternId })
    .query() → TrendPatternWithConcepts
  
  // Send pattern to approval queue
  sendToApproval: nicheHunterProcedure
    .input({ patternId })
    .mutation() → { success }
  
  // Dismiss a pattern
  dismissPattern: nicheHunterProcedure
    .input({ patternId })
    .mutation() → { success }
  
  // Batch actions
  batchAction: nicheHunterProcedure
    .input({ patternIds: string[], action: 'approve' | 'dismiss' })
    .mutation() → { success, count }
})
```

### 5.3 approval.router.ts

```typescript
approval: router({
  // Get pending concepts awaiting approval
  getPending: workspaceProcedure
    .input({ patternId? })
    .query() → ConceptWithPattern[]
  
  // Approve a concept (moves to design generation)
  approve: workspaceProcedure
    .input({ conceptId, designCount?: number })
    .mutation() → { success }
  
  // Reject a concept
  reject: workspaceProcedure
    .input({ conceptId, reason?: string })
    .mutation() → { success }
  
  // Batch approve
  batchApprove: workspaceProcedure
    .input({ conceptIds: number[], designCount?: number })
    .mutation() → { success, count }
  
  // Batch reject
  batchReject: workspaceProcedure
    .input({ conceptIds: number[], reason?: string })
    .mutation() → { success, count }
  
  // Get approval stats
  getStats: workspaceProcedure
    .query() → { pending, approved, rejected, generating, complete }
})
```

### 5.4 revision.router.ts

```typescript
revision: router({
  // Get designs ready for review (generated but not accepted)
  getReviewQueue: workspaceProcedure
    .input({ conceptId? })
    .query() → ConceptWithVariations[]
  
  // Submit a revision instruction
  submitRevision: workspaceProcedure
    .input({ conceptId, variationKey: 'A'|'B'|'C', instruction: string })
    .mutation() → { revisionId, status: 'generating' }
  
  // Poll revision generation status
  getRevisionStatus: workspaceProcedure
    .input({ revisionId })
    .query() → { status, resultImageUrl? }
  
  // Accept a design variation (original or revised)
  acceptDesign: workspaceProcedure
    .input({ conceptId, variationKey, imageUrl })
    .mutation() → { success }
  
  // Get revision history for a concept
  getHistory: workspaceProcedure
    .input({ conceptId, variationKey })
    .query() → DesignRevision[]
  
  // Revert to original (discard all revisions)
  revertToOriginal: workspaceProcedure
    .input({ conceptId, variationKey })
    .mutation() → { success }
})
```

### 5.5 mockup.router.ts

```typescript
mockup: router({
  // Trigger mockup generation for an accepted design
  generate: workspaceProcedure
    .input({ conceptId, productGroupId })
    .mutation() → { success, mockupCount }
  
  // Get mockup renders for a concept
  getMockups: workspaceProcedure
    .input({ conceptId })
    .query() → MockupRender[]
  
  // Regenerate a single mockup (different placement)
  regenerate: workspaceProcedure
    .input({ mockupId })
    .mutation() → { success, newUrl }
  
  // Get best color matches for a design
  getColorMatches: workspaceProcedure
    .input({ conceptId, productGroupId, count?: number })
    .query() → MockupTemplate[]
})
```

### 5.6 shopify.router.ts

```typescript
shopify: router({
  // Post product to Shopify
  postProduct: workspaceProcedure
    .input({ conceptId, productGroupId, title?: string })
    .mutation() → { success, shopifyProductId, shopifyUrl }
  
  // Get posted products
  getProducts: workspaceProcedure
    .input({ status?, limit?, offset? })
    .query() → ShopifyProduct[]
  
  // Get connection status
  getConnectionStatus: workspaceProcedure
    .query() → { connected: boolean, storeUrl?: string }
  
  // Test connection
  testConnection: workspaceProcedure
    .mutation() → { success, storeName?: string }
})
```

### 5.7 productGroup.router.ts

```typescript
productGroup: router({
  // List product groups for workspace
  list: workspaceProcedure.query() → ProductGroup[]
  
  // Create product group
  create: workspaceProcedure
    .input({ name, compareAtPrice, printZone })
    .mutation() → ProductGroup
  
  // Update product group
  update: workspaceProcedure
    .input({ id, name?, compareAtPrice?, printZone? })
    .mutation() → ProductGroup
  
  // Add size pricing tier
  addPricingTier: workspaceProcedure
    .input({ productGroupId, label, sizeList: string[], price })
    .mutation() → SizePricingTier
  
  // Update pricing tier
  updatePricingTier: workspaceProcedure
    .input({ tierId, label?, sizeList?, price? })
    .mutation() → SizePricingTier
  
  // Delete pricing tier
  deletePricingTier: workspaceProcedure
    .input({ tierId })
    .mutation() → { success }
  
  // Add mockup template (blank shirt photo)
  addTemplate: workspaceProcedure
    .input({ productGroupId, colorName, hexCode, imageUrl, availableSizes })
    .mutation() → MockupTemplate
  
  // Update mockup template
  updateTemplate: workspaceProcedure
    .input({ templateId, colorName?, hexCode?, imageUrl?, availableSizes? })
    .mutation() → MockupTemplate
  
  // Delete mockup template
  deleteTemplate: workspaceProcedure
    .input({ templateId })
    .mutation() → { success }
  
  // Reorder templates
  reorderTemplates: workspaceProcedure
    .input({ templateIds: string[] })
    .mutation() → { success }
})
```

---

## 6. Pipeline Orchestrator Refactor

### 6.1 Universal Pipeline Interface

```typescript
// server/engines/pipeline/index.ts

export interface PipelineConfig {
  topicsPerScan: number;       // 3–20
  conceptsPerTopic: number;    // 3–10
  approvalMode: 'auto' | 'manual';
  winnersToGenerate: number;   // 3–ALL
  variationsPerWinner: number; // 1–5
}

export interface PipelineContext {
  workspace: Workspace;
  config: PipelineConfig;
  credentials: WorkspaceCredentials;
  runId: number;
  signal?: AbortSignal;
}

// Stage interface — all stages implement this
export interface PipelineStage {
  name: string;
  execute(ctx: PipelineContext): Promise<StageResult>;
}

export interface StageResult {
  success: boolean;
  itemsProcessed: number;
  error?: string;
}
```

### 6.2 NYT Pipeline (Refactored)

```typescript
// server/engines/pipeline/nytPipeline.ts

export function buildNytPipeline(): PipelineStage[] {
  return [
    new NytDiscoveryStage(),      // Stage 1: Fetch NYT Bestsellers
    new ForumScrapingStage(),     // Stage 2: Scrape forums per book
    new NicheResearchStage(),     // Stage 3: Deep niche research
    new WorldBibleStage(),        // Stage 3b: World Bible extraction
    new ConceptGenerationStage(), // Stage 4: Generate concepts
    new ScoringStage(),           // Stage 5: Etsy validation
    // --- Approval gate (auto mode: select top N) ---
    new ImageGenerationStage(),   // Stage 6: DTF image generation
    new ReportingStage(),         // Stage 7: Report + notify
  ];
}
```

### 6.3 Niche Hunter Pipeline (New)

```typescript
// server/engines/pipeline/nicheHunterPipeline.ts

export function buildNicheHunterPipeline(): PipelineStage[] {
  return [
    new CrossNicheScanStage(),    // Step 1: Etsy broad category scan
    new InNicheScanStage(),       // Step 2: Reddit + Etsy niche scan
    new PatternDeconstructStage(),// Step 3: LLM vision deconstruction
    new AdaptationStage(),        // Step 4: Pattern × Niche adaptation
    new SaturationCheckStage(),   // Step 5: Etsy white space scoring
    // --- STOPS HERE: Results go to Approval Queue ---
  ];
}

// Post-approval pipeline (triggered per approved concept)
export function buildDesignPipeline(): PipelineStage[] {
  return [
    new ImageGenerationStage(),   // Generate DTF designs (A/B/C)
    // --- STOPS HERE: Results go to Design Studio for review ---
  ];
}

// Post-acceptance pipeline (triggered per accepted design)
export function buildPostProductionPipeline(): PipelineStage[] {
  return [
    new MockupGenerationStage(),  // Composite on best N shirts
    new ShopifyPostingStage(),    // Auto-post to store
  ];
}
```

### 6.4 Pipeline Runner (Universal)

```typescript
// server/engines/pipeline/runner.ts

export async function runPipeline(
  stages: PipelineStage[],
  ctx: PipelineContext
): Promise<void> {
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    
    // Update run status
    await updateRunStage(ctx.runId, i + 1, stages.length, stage.name, 'running');
    
    // Execute with self-healing
    const result = await withSelfHeal({
      name: `pipeline-${stage.name}`,
      primaryFn: () => stage.execute(ctx),
      fallbackFn: () => ({ success: false, itemsProcessed: 0, error: 'Stage failed after retries' }),
      maxRetries: 2,
    });
    
    if (!result.success) {
      await failRun(ctx.runId, result.error || 'Unknown error');
      return;
    }
    
    await updateRunStage(ctx.runId, i + 1, stages.length, stage.name, 'complete');
    
    // Check for abort
    if (ctx.signal?.aborted) {
      await failRun(ctx.runId, 'Pipeline cancelled by user');
      return;
    }
  }
  
  await completeRun(ctx.runId, stages.length);
}
```

---

## 7. Niche Hunter Engine

### 7.1 Cross-Niche Scanner

```typescript
// server/engines/nicheHunter/crossNicheScan.ts

export interface CrossNicheResult {
  listings: EtsyListing[];
  patterns: DeconstructedPattern[];
}

export async function scanCrossNiche(
  categories: string[],
  config: { minSales: number; recencyMonths: number; maxListings: number },
  credentials: WorkspaceCredentials
): Promise<CrossNicheResult> {
  // 1. Search Etsy API for each category
  // 2. Filter by sales threshold + recency
  // 3. Sort by sales velocity
  // 4. Take top N listings
  // 5. For each: download image → LLM vision deconstruction
  // 6. Deduplicate similar patterns
  // 7. Return unique patterns with source attribution
}
```

### 7.2 Pattern Deconstructor (LLM Vision)

```typescript
// server/engines/nicheHunter/patternDeconstructor.ts

export interface DeconstructedPattern {
  patternName: string;
  composition: 'silhouette' | 'badge' | 'typography' | 'illustration' | 'mixed';
  colorStrategy: 'single-color' | 'duotone' | 'full-color' | 'monochrome';
  emotionalHook: string;
  transferablePattern: string;  // What makes it work, abstracted from specific subject
  subjectType: string;          // "animal", "object", "text", "scene"
  actionOrPose: string;         // "blowing dandelion", "hiking", "sleeping"
  whyItWorks: string;           // "Contrast between power and gentleness"
}

const DECONSTRUCT_SYSTEM = `You are a design pattern analyst for t-shirt graphics.
Given a product image, deconstruct it into its transferable design pattern.
Focus on WHAT MAKES IT WORK — not the specific subject.
...`;
```

### 7.3 Adaptation Engine

```typescript
// server/engines/nicheHunter/adaptationEngine.ts

export interface AdaptedConcept {
  title: string;
  description: string;
  adaptationRationale: string;
  sourcePhrase: string;          // From in-niche Reddit research
  whiteSpaceScore: number;       // 1-10
  salesPotential: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedComposition: string;
  suggestedColorStrategy: string;
}

const ADAPTATION_SYSTEM = `You are a creative director adapting proven design patterns 
for a specific niche audience. Given:
1. A transferable pattern (from a hot-selling design outside the niche)
2. Niche research (phrases, jokes, cultural moments from the target audience)
3. Niche profile (demographics, tone, interests)

Generate adapted concept proposals that:
- Keep the EMOTIONAL HOOK that made the source pattern successful
- Replace the SUBJECT with something relevant to the target niche
- Anchor to a REAL PHRASE from the niche research (not invented)
- Score for white space (is this adaptation already done on Etsy?)
...`;
```

---

## 8. Approval State Machine

### 8.1 Concept Status Flow

```
                    ┌─────────────────────────────────────────┐
                    │                                           │
  [Generated] ──→ PENDING ──→ APPROVED ──→ GENERATING ──→ DESIGNED
                    │                                           │
                    └──→ REJECTED                               │
                                                                │
                    ┌───────────────────────────────────────────┘
                    │
                    ▼
              IN_REVIEW ──→ REVISION_PENDING ──→ IN_REVIEW (loop)
                    │
                    └──→ ACCEPTED ──→ MOCKUP_PENDING ──→ POSTED
```

### 8.2 State Transitions

```typescript
// shared/types.ts

export type ConceptStatus = 
  | 'pending'           // Awaiting user approval
  | 'approved'          // Approved, waiting for image generation
  | 'rejected'          // User rejected
  | 'generating'        // Image generation in progress
  | 'designed'          // Images generated, ready for review
  | 'in_review'         // User is reviewing designs
  | 'revision_pending'  // Revision requested, generating new version
  | 'accepted'          // Final design accepted
  | 'mockup_pending'    // Mockup generation in progress
  | 'posted'            // Posted to Shopify

export const VALID_TRANSITIONS: Record<ConceptStatus, ConceptStatus[]> = {
  pending: ['approved', 'rejected'],
  approved: ['generating'],
  rejected: [],  // Terminal
  generating: ['designed'],
  designed: ['in_review'],
  in_review: ['revision_pending', 'accepted'],
  revision_pending: ['in_review'],  // Back to review after revision completes
  accepted: ['mockup_pending'],
  mockup_pending: ['posted'],
  posted: [],  // Terminal
};
```

---

## 9. Design Revision Engine

### 9.1 Revision Flow

```typescript
// server/engines/revision/index.ts

export async function generateRevision(
  conceptId: number,
  variationKey: string,
  instruction: string,
  referenceImageUrl: string
): Promise<{ revisionId: string; imageUrl: string }> {
  // 1. Build prompt from instruction + concept metadata
  const prompt = buildRevisionPrompt(instruction, concept);
  
  // 2. Call GPT Image generation with reference
  const { url: imageUrl } = await generateImage({
    prompt,
    originalImages: [{ url: referenceImageUrl, mimeType: 'image/png' }],
  });
  
  // 3. Store revision record
  const revisionId = nanoid();
  await insertRevision({
    id: revisionId,
    conceptId,
    variationKey,
    iterationNumber: await getNextIterationNumber(conceptId, variationKey),
    instruction,
    referenceImageUrl,
    resultImageUrl: imageUrl,
    accepted: false,
    createdAt: Date.now(),
  });
  
  return { revisionId, imageUrl };
}
```

### 9.2 Revision Prompt Builder

```typescript
// server/engines/revision/prompts.ts

export function buildRevisionPrompt(
  instruction: string,
  concept: ConceptWithMetadata
): string {
  return `You are revising a DTF t-shirt design. The original design is attached as reference.

DESIGN CONTEXT:
- Concept: ${concept.title}
- Style: ${concept.format}
- Current variation: ${concept.variationKey}

USER'S REVISION INSTRUCTION:
${instruction}

CONSTRAINTS (always maintain):
- DTF Silhouette Rule: NO solid background fills. White/transparent space visible between all elements.
- Outer shape must be an organic graphic silhouette (badge, arch, diamond, etc.) — NOT a rectangle.
- Print Safety: design must work as a physical transfer on fabric.
- Maintain the core concept identity while applying the requested changes.

Generate the revised design following the user's instruction while preserving all DTF constraints.`;
}
```

---

## 10. Mockup Compositor

### 10.1 Sharp Overlay Logic

```typescript
// server/engines/mockup/compositor.ts
import sharp from 'sharp';

export interface CompositeConfig {
  designUrl: string;          // Transparent PNG from S3
  mockupUrl: string;          // Blank shirt photo from S3
  printZone: { x: number; y: number; width: number; height: number }; // Ratios 0-1
}

export async function compositeDesignOnMockup(config: CompositeConfig): Promise<Buffer> {
  // 1. Download both images
  const [designBuf, mockupBuf] = await Promise.all([
    downloadImage(config.designUrl),
    downloadImage(config.mockupUrl),
  ]);
  
  // 2. Get mockup dimensions
  const mockupMeta = await sharp(mockupBuf).metadata();
  const mockupW = mockupMeta.width!;
  const mockupH = mockupMeta.height!;
  
  // 3. Calculate print zone in pixels
  const zoneX = Math.round(config.printZone.x * mockupW);
  const zoneY = Math.round(config.printZone.y * mockupH);
  const zoneW = Math.round(config.printZone.width * mockupW);
  const zoneH = Math.round(config.printZone.height * mockupH);
  
  // 4. Resize design to fit print zone (maintain aspect ratio)
  const resizedDesign = await sharp(designBuf)
    .resize(zoneW, zoneH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  
  // 5. Get resized dimensions for centering
  const resizedMeta = await sharp(resizedDesign).metadata();
  const offsetX = zoneX + Math.round((zoneW - resizedMeta.width!) / 2);
  const offsetY = zoneY + Math.round((zoneH - resizedMeta.height!) / 2);
  
  // 6. Composite
  const result = await sharp(mockupBuf)
    .composite([{ input: resizedDesign, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();
  
  return result;
}
```

### 10.2 Color Matcher

```typescript
// server/engines/mockup/colorMatcher.ts

export async function pickBestColors(
  designImageUrl: string,
  templates: MockupTemplate[],
  count: number
): Promise<MockupTemplate[]> {
  // Use LLM to analyze design colors and pick best shirt matches
  const response = await invokeLLM({
    messages: [
      { role: 'system', content: COLOR_MATCH_SYSTEM },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: designImageUrl } },
        { type: 'text', text: `Available shirt colors:\n${templates.map(t => 
          `- ${t.colorName} (${t.hexCode})`).join('\n')}\n\nPick the ${count} best-matching colors.` }
      ]}
    ],
    response_format: { type: 'json_schema', json_schema: { ... } }
  });
  
  // Parse response and return ordered templates
}
```

---

## 11. Shopify Integration

### 11.1 API Client

```typescript
// server/engines/shopify/api.ts

export class ShopifyClient {
  private storeUrl: string;
  private accessToken: string;
  
  constructor(credentials: { storeUrl: string; accessToken: string }) {
    this.storeUrl = credentials.storeUrl;
    this.accessToken = credentials.accessToken;
  }
  
  async createProduct(product: ShopifyProductInput): Promise<ShopifyProductResponse> {
    const url = `${this.storeUrl}/admin/api/2024-01/products.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken,
      },
      body: JSON.stringify({ product }),
    });
    return response.json();
  }
  
  async uploadImage(productId: string, imageUrl: string, alt: string): Promise<void> { ... }
}
```

### 11.2 Variant Matrix Builder

```typescript
// server/engines/shopify/variantBuilder.ts

export interface ShopifyVariant {
  option1: string;  // Color name
  option2: string;  // Size
  price: string;
  compare_at_price: string;
  sku: string;
  inventory_quantity: number;
  requires_shipping: boolean;
}

export function buildVariantMatrix(
  selectedTemplates: MockupTemplate[],
  pricingTiers: SizePricingTier[],
  compareAtPrice: number
): ShopifyVariant[] {
  const variants: ShopifyVariant[] = [];
  
  for (const template of selectedTemplates) {
    const availableSizes = template.availableSizes as string[];
    
    for (const size of availableSizes) {
      // Find which pricing tier this size belongs to
      const tier = pricingTiers.find(t => 
        (t.sizeList as string[]).includes(size)
      );
      
      if (!tier) continue;
      
      variants.push({
        option1: template.colorName,
        option2: size,
        price: tier.price.toFixed(2),
        compare_at_price: compareAtPrice.toFixed(2),
        sku: `${template.colorName.toUpperCase().replace(/\s/g, '-')}-${size}`,
        inventory_quantity: 999,  // Print-on-demand = unlimited
        requires_shipping: true,
      });
    }
  }
  
  return variants;
}
```

### 11.3 Title Generator

```typescript
// server/engines/shopify/titleGenerator.ts

const TITLE_SYSTEM = `You are a product title writer for a t-shirt brand.
Generate SHORT, catchy product titles (2-5 words max).
Style reference: "Blowing Wishes T-Shirt", "Sunrise Pines Tee", "Slow Hiking Society Snail T-Shirt"
Rules:
- Always end with "T-Shirt" or "Tee"
- No quotes, no special characters
- Capitalize each word
- Capture the essence of the design in minimal words`;

export async function generateTitle(concept: ConceptMetadata): Promise<string> {
  const response = await invokeLLM({
    messages: [
      { role: 'system', content: TITLE_SYSTEM },
      { role: 'user', content: `Design concept: ${concept.title}\nDescription: ${concept.description}\nGenerate a short product title.` }
    ],
  });
  return response.choices[0].message.content.trim();
}
```

---

## 12. Frontend Architecture

### 12.1 Workspace Context

```typescript
// client/src/contexts/WorkspaceContext.tsx

interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  isLoading: boolean;
  switchWorkspace: (id: string) => void;
  refetch: () => void;
}

// Provides workspace state to entire app
// Persists active workspace in localStorage + server
// Injects X-Workspace-Id header into all tRPC calls
```

### 12.2 tRPC Client Modification

```typescript
// client/src/main.tsx — MODIFICATION

// Add workspace header to all requests
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      headers() {
        const workspaceId = localStorage.getItem('activeWorkspaceId');
        return workspaceId ? { 'x-workspace-id': workspaceId } : {};
      },
    }),
  ],
  transformer: superjson,
});
```

### 12.3 Routing Structure

```typescript
// client/src/App.tsx — MODIFIED

<Route path="/" component={WorkspaceRedirect} />

{/* Workspace-scoped routes */}
<Route path="/w/:workspaceSlug" nest>
  <Route path="/dashboard" component={Dashboard} />
  <Route path="/niche-hunter" component={NicheHunter} />
  <Route path="/approval" component={ApprovalQueue} />
  <Route path="/design-studio" component={DesignStudio} />
  <Route path="/mockups" component={Mockups} />
  <Route path="/shopify" component={ShopifyProducts} />
  <Route path="/library" component={ConceptLibrary} />
  <Route path="/favorites" component={Favorites} />
  <Route path="/runs" component={RunHistory} />
  <Route path="/config" component={PipelineConfig} />
  <Route path="/products" component={ProductGroups} />
  <Route path="/status" component={Status} />
  <Route path="/analytics" component={Analytics} />
  <Route path="/health" component={SystemHealth} />
  <Route path="/book/:bookId" component={BookDetail} />
</Route>

{/* Onboarding (no workspace context) */}
<Route path="/onboarding" component={OnboardingWizard} />
```

### 12.4 DashboardLayout Modification

```typescript
// client/src/components/DashboardLayout.tsx — MODIFICATION

// Add WorkspaceSwitcher at top of sidebar
// Conditionally show nav items based on workspace.workspaceType:
//   - 'nyt': Dashboard, Library, Favorites, Runs, Config, Analytics, Health
//   - 'niche_hunter': Dashboard, Niche Hunter, Approval, Design Studio, 
//                     Mockups, Shopify, Library, Favorites, Runs, Products, Config, Health

// Badge counts on nav items:
//   - Approval: pending count
//   - Design Studio: in_review count
//   - Mockups: mockup_pending count
```

---

## 13. Workspace Context and Routing

### 13.1 URL Strategy

```
Current:  /dashboard, /library, /status, /book/123
After:    /w/nyt-books/dashboard, /w/pickleball/library, /w/nyt-books/book/123
```

### 13.2 Backward Compatibility

- Old URLs (`/dashboard`) redirect to `/w/{lastActiveWorkspace}/dashboard`
- Deep links with `?workspace=slug` resolve correctly
- All existing bookmarks continue working via redirect

### 13.3 Data Isolation

Every query that returns workspace-scoped data MUST include a `WHERE workspaceId = ?` clause. This is enforced at the db helper level:

```typescript
// server/db/concept.db.ts
export async function getConceptsByWorkspace(workspaceId: string, opts: QueryOpts) {
  const db = await getDb();
  return db.select().from(designConcepts)
    .where(eq(designConcepts.workspaceId, workspaceId))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}
```

---

## 14. Migration Strategy (NYT Backward Compat)

### 14.1 Phase A Migration Steps

1. Create `workspaces` table
2. Insert default NYT workspace (`ws-nyt-default`)
3. Add `workspaceId` column (nullable) to existing tables
4. Backfill all existing rows with `ws-nyt-default`
5. Make `workspaceId` NOT NULL (after backfill)
6. Add indexes on `workspaceId` columns

### 14.2 Code Migration Steps

1. Keep `server/routers.ts` as a re-export shim (imports from `server/routers/index.ts`)
2. Keep `server/db.ts` as a re-export shim (imports from `server/db/*.ts`)
3. Keep `server/pipeline.ts` as a re-export shim (imports from `server/engines/pipeline/`)
4. Gradually move logic to new locations
5. Remove shims once all references are updated

### 14.3 Zero-Downtime Guarantee

- All `workspaceId` columns start as nullable
- Default workspace is created before any backfill
- Existing queries continue working (null workspaceId matches everything in old code)
- New workspace-scoped queries only activate when workspace context is present
- Frontend falls back to default workspace if none selected

---

## 15. Testing Strategy

### 15.1 Test Files (New)

```
server/engines/nicheHunter/crossNicheScan.test.ts
server/engines/nicheHunter/adaptationEngine.test.ts
server/engines/pipeline/runner.test.ts
server/engines/mockup/compositor.test.ts
server/engines/shopify/variantBuilder.test.ts
server/engines/revision/index.test.ts
server/routers/workspace.router.test.ts
server/routers/approval.router.test.ts
server/db/workspace.db.test.ts
```

### 15.2 Test Patterns

```typescript
// Example: variantBuilder.test.ts
import { describe, it, expect } from 'vitest';
import { buildVariantMatrix } from './variantBuilder';

describe('buildVariantMatrix', () => {
  it('generates correct Color × Size × Price combinations', () => {
    const templates = [
      { colorName: 'Butter', availableSizes: ['S','M','L','XL','2XL'] },
      { colorName: 'Navy', availableSizes: ['S','M','L','XL'] },
    ];
    const tiers = [
      { label: 'S-XL', sizeList: ['S','M','L','XL'], price: 34.95 },
      { label: '2XL', sizeList: ['2XL'], price: 37.95 },
    ];
    
    const variants = buildVariantMatrix(templates, tiers, 49.95);
    
    expect(variants).toHaveLength(9); // Butter×5 + Navy×4
    expect(variants.find(v => v.option1 === 'Butter' && v.option2 === '2XL')?.price).toBe('37.95');
    expect(variants.every(v => v.compare_at_price === '49.95')).toBe(true);
  });
});
```

---

## 16. Dependency Additions

### 16.1 New npm Packages

| Package | Purpose | Phase |
|---|---|---|
| `sharp` | Image compositing for mockups | G |
| `crypto-js` or Node `crypto` | Credential encryption | A |
| `@shopify/shopify-api` | Shopify Admin API client | H |

### 16.2 Existing Packages (Already Installed, Reused)

| Package | Reused for |
|---|---|
| `axios` | Etsy API calls (already used for forum scraping) |
| `cheerio` | HTML parsing for Reddit scraping |
| `nanoid` | UUID generation for new tables |
| `zod` | Input validation for all new procedures |
| `drizzle-orm` | All new table definitions and queries |

---

## Summary: What Gets Built Per Phase

| Phase | New Files | Modified Files | New Tables | New Procedures |
|---|---|---|---|---|
| **A** | `workspace.router.ts`, `workspace.db.ts`, `WorkspaceContext.tsx`, `WorkspaceSwitcher.tsx`, `workspaceResolver.ts` | `context.ts`, `trpc.ts`, `DashboardLayout.tsx`, `App.tsx`, `main.tsx`, `schema.ts` | `workspaces`, `workspace_credentials` | 7 (workspace CRUD) |
| **B** | `PipelineConfig.tsx`, `PipelineConfigForm.tsx` | `routers.ts` (or new router), `pipeline.ts` | — | 2 (get/update config) |
| **C** | `OnboardingWizard.tsx`, `NicheProfileStep.tsx`, `ResearchConfigStep.tsx`, `ProductSetupStep.tsx` | `workspace.router.ts` | — | 1 (onboardingChat) |
| **D** | `ProductGroups.tsx`, `ProductGroupEditor.tsx`, `productGroup.router.ts`, `productGroup.db.ts` | `schema.ts` | `product_groups`, `size_pricing_tiers`, `mockup_templates` | 9 (CRUD) |
| **E** | `engines/nicheHunter/*` (5 files), `nicheHunter.router.ts`, `trendPattern.db.ts`, `NicheHunter.tsx`, `PatternCard.tsx` | `schema.ts` | `trend_patterns` | 6 |
| **F** | `approval.router.ts`, `ApprovalQueue.tsx`, `ApprovalCard.tsx` | `schema.ts` (add status columns) | — | 6 |
| **G** | `engines/revision/*` (2 files), `revision.router.ts`, `revision.db.ts`, `DesignStudio.tsx`, `RevisionPanel.tsx` | `schema.ts` | `design_revisions` | 6 |
| **H** | `engines/mockup/*` (3 files), `mockup.router.ts`, `mockup.db.ts`, `Mockups.tsx`, `MockupGallery.tsx` | `schema.ts` | `mockup_renders` | 4 |
| **I** | `engines/shopify/*` (4 files), `shopify.router.ts`, `shopify.db.ts`, `ShopifyProducts.tsx` | `schema.ts` | `shopify_products` | 4 |

**Total new files:** ~45  
**Total new tables:** 8  
**Total new tRPC procedures:** ~45  
**Estimated LOC:** ~8,000–10,000

---

*This blueprint is complete. All modules, contracts, state machines, and wiring points are mapped. Ready for PO approval before implementation begins.*
