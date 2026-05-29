# Workspace Architecture — FINAL PLAN (v6)

**Date:** May 29, 2026  
**Status:** All PO decisions locked. Ready for implementation.  
**Supersedes:** v1–v5

---

## All Locked Decisions

| # | Decision | Final answer |
|---|---|---|
| 1 | Grouping unit (non-NYT) | **Trend Pattern** (equivalent to Book ID) |
| 2 | Default images per run | **15** (configurable) |
| 3 | NYT pipeline | **Also becomes configurable** (same settings panel) |
| 4 | Niche Hunter source | **Dual scan:** Cross-niche hot sellers + In-niche Reddit/Etsy |
| 5 | Mockup compositing | CSS/Canvas overlay (Sharp) — no AI editing |
| 6 | Design revision | GPT Image generation with reference — unlimited iterations |
| 7 | Final output | Auto-post to Shopify |
| 8 | Title | LLM-generated short title |
| 9 | Description | Site-wide template per workspace |
| 10 | Pricing | Per size tier within product group (S–XL / 2XL / 3XL+) |
| 11 | Compare-at price | Per product group (strikethrough) |
| 12 | Credentials | Per-workspace (stored encrypted) |
| 13 | Niche Hunter frequency | Manual trigger ("Run Now") for v1 |
| 14 | First new workspace | Pickleball |
| 15 | Upscale | 1000px wide, 300 DPI |
| 16 | Mockup colors | Best N (LLM picks) |
| 17 | Revision limit | Unlimited |
| 18 | Credential management | Via chat for now; admin UI in future phase |

---

## Part 1: The Universal Pipeline Model

Both NYT and Pickleball (and all future workspaces) share the same underlying pipeline architecture. The difference is **what plugs into each stage.**

### 1.1 Pipeline Stages (Universal)

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNIVERSAL PIPELINE                             │
│                                                                   │
│  STAGE 1: DISCOVERY                                              │
│    What: Find topics/patterns to research                        │
│    NYT: Fetch NYT Bestseller list → 6 books                     │
│    Pickleball: Cross-niche scan + In-niche scan → N patterns     │
│                                                                   │
│  STAGE 2: RESEARCH                                               │
│    What: Deep-dive each topic for cultural intelligence          │
│    NYT: Forum scraping + niche research per book                 │
│    Pickleball: Reddit conversations + Etsy saturation per topic  │
│                                                                   │
│  STAGE 3: CONCEPT GENERATION                                     │
│    What: Generate design concepts anchored to real language       │
│    NYT: 5 concepts per book (phrase-first)                       │
│    Pickleball: N concepts per pattern (adaptation-first)         │
│                                                                   │
│  STAGE 4: SCORING + VALIDATION                                   │
│    What: Rank concepts by market opportunity                     │
│    NYT: Etsy saturation scoring                                  │
│    Pickleball: Source sales velocity + white space score          │
│                                                                   │
│  ─── APPROVAL GATE (configurable: auto or manual) ───           │
│    NYT (current): Auto — top N winners proceed                   │
│    Pickleball: Manual — user approves which proceed              │
│    NYT (future option): Can enable manual approval too           │
│                                                                   │
│  STAGE 5: IMAGE GENERATION                                       │
│    What: Generate DTF-ready designs for approved concepts        │
│    Both: Same engine — 10-layer formula, DTF Silhouette Rule     │
│                                                                   │
│  STAGE 6: POST-PRODUCTION                                        │
│    What: Finalize and deliver                                    │
│    NYT: Report assembly + notification                           │
│    Pickleball: Revision → Mockup → Shopify posting              │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Configurable Pipeline Settings (Per Workspace)

These settings live in the workspace config and control the pipeline's behavior:

```
┌─────────────────────────────────────────────────────────────────┐
│  PIPELINE CONFIGURATION                                          │
│                                                                   │
│  ── DISCOVERY ──                                                 │
│  Source type:              [ NYT API ▼ ] / [ Niche Hunter ▼ ]   │
│  Patterns/topics per scan: [ 5 ▼ ]  (range: 3–20)              │
│                                                                   │
│  ── CONCEPTS ──                                                  │
│  Concepts per pattern:     [ 5 ▼ ]  (range: 3–10)              │
│  Generation style:         [ Phrase-first ▼ ] / [ Adaptation ▼ ]│
│                                                                   │
│  ── APPROVAL ──                                                  │
│  Approval mode:            [ Auto (top N) ▼ ] / [ Manual ▼ ]   │
│  Winners to generate:      [ 5 ▼ ]  (range: 3–ALL)             │
│                                                                   │
│  ── IMAGE GENERATION ──                                          │
│  Variations per winner:    [ 3 ▼ ]  (range: 1–5)               │
│                                                                   │
│  ── ESTIMATED OUTPUT ──                                          │
│  Max concepts: 25                                                │
│  Max images: 15                                                  │
│  Est. generation time: ~8 min                                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**NYT default config:**

| Setting | Value |
|---|---|
| Source type | NYT API |
| Patterns per scan | 6 (books from bestseller list) |
| Concepts per pattern | 5 |
| Approval mode | Auto (top 5) |
| Variations per winner | 3 |
| **Total images** | **15** |

**Pickleball default config:**

| Setting | Value |
|---|---|
| Source type | Niche Hunter (dual scan) |
| Patterns per scan | 5 |
| Concepts per pattern | 5 |
| Approval mode | Manual |
| Variations per winner | 3 |
| **Total images** | **Up to 15** (depends on how many you approve) |

---

## Part 2: Niche Hunter — Dual Scan Architecture

### 2.1 Cross-Niche Trend Scan (Finds Patterns)

Scans Etsy hot sellers **OUTSIDE** your niche to find winning design patterns that can be adapted.

```
INPUT:
  Cross-niche categories (configured per workspace):
    "funny shirt", "animal tee", "retro graphic tee", "vintage shirt"
  
  Filters:
    • >500 sales
    • Listed within last 6 months
    • High favorites-to-sales ratio (engagement signal)

PROCESS:
  1. Search Etsy API for each category
  2. Rank by sales velocity (sales ÷ days listed)
  3. Download top 20 listing images
  4. LLM Vision analyzes each image:
     - Composition type (silhouette, badge, typography, illustration)
     - Color strategy (single-color, duotone, full-color)
     - Emotional hook (humor, nostalgia, identity, absurdist)
     - Transferable pattern description
  5. Deduplicate similar patterns
  6. Output: 5–10 unique patterns with source attribution

OUTPUT (per pattern):
  {
    patternName: "Gentle Giant",
    sourceUrl: "https://etsy.com/listing/...",
    sourceSeller: "Sloth Hiking Club",
    salesCount: 2400,
    salesVelocity: 18/day,
    composition: "single-color animal silhouette + gentle action",
    emotionalHook: "unexpected tenderness from powerful creature",
    colorStrategy: "single ink color on garment",
    sourceImageUrl: "...",
    transferablePattern: "Replace animal + action for any niche"
  }
```

### 2.2 In-Niche Research Scan (Provides Adaptation Fuel)

Scans Reddit + Etsy **WITHIN** your niche for language, culture, and saturation data.

```
INPUT:
  In-niche keywords: "pickleball", "dinking", "kitchen line", "paddle"
  Subreddits: r/pickleball, r/10s, r/Pickleball_Memes
  Etsy niche search: "pickleball shirt", "pickleball tee"

PROCESS:
  1. Reddit: Scrape top posts + comments from configured subreddits
     - Extract: trending phrases, inside jokes, complaints, celebrations
     - Identify: what language real players use
     - Find: cultural moments (tournaments, memes, rivalries)
  
  2. Etsy in-niche: Search for existing designs
     - Map: what's already selling (saturation)
     - Identify: white space (what's NOT being done)
     - Score: competition density per sub-topic

OUTPUT:
  {
    trendingPhrases: ["I'd rather be dinking", "Third shot drop artist", ...],
    insideJokes: ["kitchen line = no man's land", ...],
    culturalMoments: ["pickleball is the fastest growing sport", ...],
    saturatedTopics: ["basic paddle graphics", "simple text tees"],
    whiteSpace: ["animal + pickleball mashups", "vintage athletic club style"],
    audienceProfile: { age: "35-65", tone: "self-deprecating", ... }
  }
```

### 2.3 Pattern × Niche Adaptation (Combines Both)

```
FOR EACH cross-niche pattern:
  INPUT:
    - Pattern description + source image
    - In-niche research (phrases, white space, audience)
    - Workspace niche profile

  LLM GENERATES:
    3–5 adapted concept proposals:
    {
      title: "Llama Blowing Dandelion-Pickleballs",
      description: "Single-color llama silhouette in profile, gently blowing...",
      adaptationRationale: "Gorilla → Llama (pickleball community mascot). 
                            Dandelion → pickleballs floating away. 
                            Same emotional hook: gentle giant.",
      sourcePhrase: "I'd rather be dinking" (anchoring phrase from Reddit),
      sourcePattern: "Gentle Giant" (FK to trend_sources),
      whiteSpaceScore: 9/10 (only 3 listings for 'pickleball llama'),
      salesPotential: "HIGH — source pattern proven at 2,400 sales"
    }

  SATURATION CHECK:
    - Search Etsy for similar concepts
    - Score: 1-10 (10 = completely fresh, 1 = oversaturated)
    - Flag if >20 similar listings exist
```

---

## Part 3: Data Model — Trend Pattern as Grouping Unit

### 3.1 Entity Hierarchy

```
WORKSPACE
  └── TREND PATTERN (≡ Book in NYT)
        ├── Source: cross-niche listing that inspired it
        ├── Research: in-niche data that fueled adaptation
        └── CONCEPTS (3–10 per pattern)
              ├── Concept 1: "Llama blowing dandelion-pickleballs"
              │     ├── Variation A (Clean/Bold)
              │     ├── Variation B (Distressed/Aged)
              │     └── Variation C (Alt Composition)
              ├── Concept 2: "Bear gently dinking"
              │     ├── Variation A
              │     ├── Variation B
              │     └── Variation C
              └── Concept 3: ...
```

### 3.2 How This Maps to NYT

| NYT entity | Universal entity | Pickleball entity |
|---|---|---|
| Book (from NYT API) | **Trend Pattern** | Discovered pattern (from Etsy cross-niche) |
| Book metadata | Pattern metadata | Source listing + deconstruction |
| Forum scraping data | Research data | Reddit + Etsy in-niche data |
| Niche research | Research data | Same — fan conversations, white space |
| World Bible | Pattern profile | Adaptation profile (color, composition, hook) |
| 5 concepts per book | N concepts per pattern | 3–5 adapted concepts per pattern |
| sourcePhrase | sourcePhrase | sourcePhrase (from Reddit) |
| Etsy score | Opportunity score | White space score + sales velocity |

### 3.3 Database Schema

#### Core Tables (New)

```sql
-- Workspaces
CREATE TABLE workspaces (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  icon VARCHAR(10),
  nicheProfile JSON,           -- LLM-generated niche profile
  descriptionTemplate TEXT,    -- Site-wide Shopify description
  pipelineConfig JSON,         -- Configurable pipeline settings
  crossNicheCategories JSON,   -- ["funny shirt", "animal tee", ...]
  inNicheKeywords JSON,        -- ["pickleball", "dinking", ...]
  subreddits JSON,             -- ["r/pickleball", "r/10s", ...]
  status ENUM('setup', 'active', 'paused'),
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL
);

-- Per-workspace credentials (encrypted)
CREATE TABLE workspace_credentials (
  id VARCHAR(36) PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  provider ENUM('shopify', 'etsy', 'reddit', 'custom'),
  credKey VARCHAR(100) NOT NULL,    -- e.g., 'SHOPIFY_ACCESS_TOKEN'
  credValue TEXT NOT NULL,          -- encrypted
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id)
);

-- Trend Patterns (≡ Books in NYT)
CREATE TABLE trend_patterns (
  id VARCHAR(36) PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  patternName VARCHAR(255) NOT NULL,
  sourceUrl TEXT,
  sourceSeller VARCHAR(255),
  sourceImageUrl TEXT,
  salesCount INT,
  salesVelocity FLOAT,
  composition VARCHAR(100),       -- "silhouette", "badge", "typography"
  emotionalHook VARCHAR(255),
  colorStrategy VARCHAR(100),
  transferablePattern TEXT,
  inNicheResearch JSON,           -- Reddit phrases, white space, etc.
  adaptationProfile JSON,         -- How to adapt for this niche
  status ENUM('discovered', 'approved', 'generating', 'complete', 'dismissed'),
  runId VARCHAR(36),
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id)
);

-- Product Groups (mockup templates + pricing)
CREATE TABLE product_groups (
  id VARCHAR(36) PRIMARY KEY,
  workspaceId VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,       -- "Comfort Colors 1717"
  compareAtPrice DECIMAL(10,2),     -- $49.95
  printZone JSON,                   -- { x, y, width, height } relative to mockup
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id)
);

-- Size Pricing Tiers
CREATE TABLE size_pricing_tiers (
  id VARCHAR(36) PRIMARY KEY,
  productGroupId VARCHAR(36) NOT NULL,
  label VARCHAR(50) NOT NULL,       -- "S-XL", "2XL", "3XL+"
  sizeList JSON NOT NULL,           -- ["S","M","L","XL"] or ["3XL","4XL","5XL"]
  price DECIMAL(10,2) NOT NULL,     -- $34.95
  FOREIGN KEY (productGroupId) REFERENCES product_groups(id)
);

-- Mockup Templates (blank product photos)
CREATE TABLE mockup_templates (
  id VARCHAR(36) PRIMARY KEY,
  productGroupId VARCHAR(36) NOT NULL,
  colorName VARCHAR(100) NOT NULL,  -- "Butter"
  hexCode VARCHAR(7) NOT NULL,      -- "#F5E6A3"
  imageUrl TEXT NOT NULL,           -- S3 URL of blank shirt photo
  availableSizes JSON NOT NULL,     -- ["S","M","L","XL","2XL","3XL"]
  sortOrder INT DEFAULT 0,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (productGroupId) REFERENCES product_groups(id)
);

-- Design Revisions (iteration history)
CREATE TABLE design_revisions (
  id VARCHAR(36) PRIMARY KEY,
  conceptId VARCHAR(36) NOT NULL,
  variationKey VARCHAR(1) NOT NULL,  -- "A", "B", "C"
  iterationNumber INT NOT NULL,
  instruction TEXT,                   -- User's revision instruction
  imageUrl TEXT NOT NULL,
  accepted BOOLEAN DEFAULT FALSE,
  createdAt BIGINT NOT NULL
);

-- Mockup Renders (composited images)
CREATE TABLE mockup_renders (
  id VARCHAR(36) PRIMARY KEY,
  conceptId VARCHAR(36) NOT NULL,
  variationKey VARCHAR(1) NOT NULL,
  templateId VARCHAR(36) NOT NULL,
  compositeUrl TEXT NOT NULL,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (templateId) REFERENCES mockup_templates(id)
);

-- Shopify Products (posted listings)
CREATE TABLE shopify_products (
  id VARCHAR(36) PRIMARY KEY,
  conceptId VARCHAR(36) NOT NULL,
  workspaceId VARCHAR(36) NOT NULL,
  shopifyProductId VARCHAR(100),
  shopifyHandle VARCHAR(255),
  title VARCHAR(255) NOT NULL,
  variantCount INT,
  status ENUM('draft', 'active', 'archived'),
  publishedAt BIGINT,
  createdAt BIGINT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id)
);
```

#### Columns Added to Existing Tables

```sql
-- Add workspaceId to all existing tables
ALTER TABLE bot_runs ADD COLUMN workspaceId VARCHAR(36);
ALTER TABLE books ADD COLUMN workspaceId VARCHAR(36);
ALTER TABLE design_concepts ADD COLUMN workspaceId VARCHAR(36);
ALTER TABLE design_concepts ADD COLUMN trendPatternId VARCHAR(36);
ALTER TABLE design_concepts ADD COLUMN approvalStatus ENUM('pending','approved','rejected') DEFAULT 'approved';
ALTER TABLE design_concepts ADD COLUMN acceptedVariation VARCHAR(1);
ALTER TABLE design_concepts ADD COLUMN acceptedImageUrl TEXT;
ALTER TABLE niche_research ADD COLUMN workspaceId VARCHAR(36);
```

---

## Part 4: NYT Workspace — What Changes

### 4.1 Functional Changes (Minimal)

| Change | Impact |
|---|---|
| `workspaceId` column added to all tables | NYT data gets a default workspace ID. Zero behavior change. |
| Pipeline settings become configurable | NYT keeps current defaults (6/5/top5/3) but user CAN now change them |
| Sidebar gets workspace switcher | NYT nav items stay identical, just wrapped in workspace context |
| URL prefix | `/dashboard` → `/workspace/nyt-books/dashboard` |
| Approval mode available | Default: Auto (current behavior). User can switch to Manual if desired. |

### 4.2 What NYT Gains (Free Improvements)

By making the pipeline configurable, NYT automatically gets:

- **Adjustable books per run** — want 10 books instead of 6? Change the setting.
- **Adjustable concepts per book** — want 7 instead of 5? Change the setting.
- **Adjustable winners** — want top 8 instead of top 5? Change the setting.
- **Optional manual approval** — want to approve concepts before image gen? Enable it.
- **More variations** — want 5 variations instead of 3? Change the setting.

All without touching the pipeline code — just config.

### 4.3 What NYT Does NOT Get (Stays Different)

| Feature | NYT | Pickleball |
|---|---|---|
| Discovery source | NYT Bestseller API | Niche Hunter (Etsy + Reddit) |
| Design revision loop | Not available (v1) | Available |
| Mockup rendering | Not available (v1) | Available |
| Shopify posting | Not available (v1) | Available |

These can be enabled for NYT in a future phase if desired.

---

## Part 5: Complete End-to-End Flow (Both Workspaces)

### 5.1 NYT Workspace Flow (After Configurability)

```
[Run Pipeline] button
  ↓
Stage 1: Fetch NYT Bestsellers → N books (configurable, default 6)
Stage 2: Forum scraping per book (Goodreads, Reddit, StoryGraph, etc.)
Stage 3: Niche research per book (fan conversations, design styles, white space)
Stage 4: Generate M concepts per book (configurable, default 5)
Stage 5: Score + validate (Etsy saturation)
  ↓
[APPROVAL GATE — configurable]
  Auto mode (default): Top K winners proceed automatically
  Manual mode (optional): User approves which concepts get images
  ↓
Stage 6: Generate V variations per winner (configurable, default 3)
Stage 7: Report + notify
  ↓
DONE — concepts visible in library
```

### 5.2 Pickleball Workspace Flow

```
[Run Niche Hunter] button
  ↓
Step 1: Cross-niche trend scan (Etsy broad categories)
  → Find N hot sellers outside your niche
  → LLM vision deconstructs each into transferable pattern
Step 2: In-niche research scan (Reddit + Etsy)
  → Scrape subreddits for phrases, jokes, cultural moments
  → Check Etsy saturation within niche
Step 3: Pattern × Niche adaptation
  → Generate M concept proposals per pattern
  → Score each for white space + sales potential
  ↓
[APPROVAL GATE — always manual]
  User reviews concept proposals
  Approves/rejects per concept
  Sets designs per concept (default 3)
  ↓
[Generate Designs] (triggered by approval)
  → DTF Silhouette Rule, 10-layer formula
  → V variations per approved concept
  ↓
[DESIGN REVIEW]
  User reviews each variation
  Accept → proceeds to mockup
  Revise → write instructions → GPT Image generates new version → repeat
  ↓
[MOCKUP GENERATION]
  LLM picks best N colors from product group
  Sharp composites design onto each blank
  ↓
[SHOPIFY POSTING]
  LLM generates short title
  System builds variant matrix (Color × Size × Price tier)
  Auto-posts to workspace's Shopify store
  ↓
DONE — product live on Shopify
```

---

## Part 6: UI/UX Design Specification

### 6.1 Visual Identity

| Token | Value | Usage |
|---|---|---|
| `--bg-deep` | `#020617` | Page background |
| `--bg-base` | `#0F172A` | Main content area |
| `--bg-elevated` | `#1E293B` | Cards, panels |
| `--foreground` | `#F8FAFC` | Primary text |
| `--foreground-muted` | `#94A3B8` | Secondary text |
| `--accent` | `#6366F1` | Primary actions (indigo) |
| `--success` | `#22C55E` | Approved, published |
| `--warning` | `#F59E0B` | Pending, in progress |
| `--destructive` | `#EF4444` | Rejected, errors |
| `--border` | `rgba(255, 255, 255, 0.08)` | Dividers |

**Typography:** Inter (headings + body) + Fira Code (data/metrics)

### 6.2 Sidebar Navigation

```
┌──────────────────────────────────────┐
│ ┌──────────────────────────────────┐ │
│ │ ▼ PICKLEBALL          [switch]   │ │  ← Workspace switcher
│ └──────────────────────────────────┘ │
│                                        │
│ ── WORKFLOW ──                        │
│ 📊 Dashboard                          │
│ 🔍 Niche Hunter                       │  ← Only in Niche Hunter workspaces
│ ✅ Approval Queue                     │  ← Shows count badge
│ 🎨 Design Studio                      │
│ 👕 Mockups                            │  ← Only in workspaces with product groups
│ 🛒 Shopify                            │  ← Only in workspaces with Shopify connected
│                                        │
│ ── LIBRARY ──                         │
│ 📚 Concept Library                    │
│ ⭐ Favorites                          │
│ 📋 Run History                        │
│                                        │
│ ── SETUP ──                           │
│ 📦 Product Groups                     │
│ ⚙️ Pipeline Config                    │  ← NEW: configurable settings
│ 🏥 System Health                      │
│                                        │
└──────────────────────────────────────┘
```

**NYT workspace sidebar** shows the same items MINUS Niche Hunter, Mockups, and Shopify (since those features aren't enabled for NYT in v1). The Pipeline Config page IS shown for NYT so the user can adjust books/concepts/winners/variations.

### 6.3 Key Pages

#### Dashboard

Pipeline status overview with metric cards:

| Metric | NYT | Pickleball |
|---|---|---|
| Card 1 | Books (6) | Patterns Found (12) |
| Card 2 | Concepts (30) | Pending Approval (5) |
| Card 3 | Images (12) | In Production (3) |
| Card 4 | Pipeline status | Posted to Shopify (47) |

Plus: Recent activity feed + Quick action buttons.

#### Niche Hunter (Pickleball only)

- "Run Now" button (top right)
- Last run timestamp + stats
- Results grouped by discovered pattern
- Each pattern card shows: source image, seller, sales data, deconstructed pattern, adapted concepts
- Actions per pattern: "Send to Approval" / "Dismiss" / "Save Pattern"

#### Approval Queue

- Batch cards grouped by pattern
- Per-concept approve/reject toggles
- Quantity selector (designs per concept)
- Bulk actions: "Approve Selected" / "Reject All" / "Request More Ideas"

#### Design Studio (Review + Revise)

- Concepts grouped by pattern
- Three variations displayed as horizontal card row (A/B/C)
- Each card: Accept (green) or Revise (indigo)
- Revision panel: side-by-side current→revised, instruction textarea, history timeline

#### Pipeline Config (NEW — Both Workspaces)

```
┌─────────────────────────────────────────────────────────────────┐
│  PIPELINE CONFIGURATION                                          │
│                                                                   │
│  ── DISCOVERY ──                                                 │
│  Source type:              [ NYT API ]  (read-only for NYT)      │
│  Topics per scan:          [ 6 ▼ ]                               │
│                                                                   │
│  ── CONCEPTS ──                                                  │
│  Concepts per topic:       [ 5 ▼ ]                               │
│                                                                   │
│  ── APPROVAL ──                                                  │
│  Mode:                     [ Auto (top N) ▼ ]                    │
│  Winners to generate:      [ 5 ▼ ]                               │
│                                                                   │
│  ── IMAGE GENERATION ──                                          │
│  Variations per winner:    [ 3 ▼ ]                               │
│                                                                   │
│  ── SUMMARY ──                                                   │
│  Max concepts: 30                                                │
│  Max images: 15                                                  │
│  Est. time: ~7 min                                               │
│                                                                   │
│  [Save Configuration]                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Workspace Switcher

- Dropdown at top of sidebar
- Shows: workspace icon + name + status dot (green=active, amber=setup)
- Lists all workspaces
- "Create New Workspace" at bottom → launches onboarding wizard
- Switching changes all content + URL prefix

### 6.5 Onboarding Wizard (Create New Workspace)

3-step chat-style wizard:
1. **Niche Profiling** — LLM asks questions, builds niche profile
2. **Market Research Config** — Set cross-niche categories, subreddits, keywords
3. **Product Setup** — Upload mockups, define pricing (can be done later)

### 6.6 Interaction Patterns

| Interaction | Behavior |
|---|---|
| Workspace switch | Dropdown + crossfade on main content |
| "Run Now" | Spinner → progress bar → "Complete" toast |
| Approve concept | Green glow + badge update |
| Reject concept | Fade to 50% + slide away |
| Generate revision | Shimmer skeleton → image fade-in |
| Accept design | Subtle confetti + green checkmark |
| Post to Shopify | Progress → "Posted!" with link |

### 6.7 Empty States

Every page has a designed empty state guiding to the next action.

### 6.8 Responsive

- Desktop (1280px+): Full sidebar + main content
- Tablet (768–1279px): Collapsible sidebar
- Mobile (<768px): Bottom tab bar

---

## Part 7: Build Order

| Phase | Name | Deliverables | Affects NYT? |
|---|---|---|---|
| **A** | Foundation | workspaces table, workspaceId columns, workspace switcher, URL routing | Yes (cosmetic only) |
| **B** | Pipeline Config | pipelineConfig JSON, settings UI, make NYT pipeline read config | Yes (gains configurability) |
| **C** | Onboarding Wizard | Chat-style niche profiling, workspace creation flow | No |
| **D** | Product Groups | product_groups, size_pricing_tiers, mockup_templates, upload UI | No |
| **E** | Niche Hunter | Dual scan (cross-niche + in-niche), trend_patterns, adaptation LLM | No |
| **F** | Approval Workflow | State machine, approval UI, pipeline trigger | No (optional enable later) |
| **G** | Design Revision | design_revisions, revision UI, GPT Image with reference | No |
| **H** | Mockup Renderer | mockup_renders, Sharp composite, color matching | No |
| **I** | Shopify Posting | shopify_products, API connection, variant builder, auto-post | No |
| **J** | Future | Scheduled hunter, admin credential UI, sales analytics, NYT post-production | — |

---

## Part 8: Technical Integration Notes

### 8.1 Per-Workspace Credentials

```
workspace_credentials table (encrypted at rest)
  Provider: shopify → SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN
  Provider: etsy → ETSY_API_KEY (for research)
  Provider: reddit → REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET (if needed)
```

Phase 1: Provided via chat → stored via webdev_request_secrets as workspace-scoped.
Future: Admin UI page per workspace.

### 8.2 Etsy API (Dual Use)

- **Cross-niche scan:** Search broad categories, sort by relevance, filter by sales
- **In-niche saturation:** Search niche keywords, count results, analyze competition
- Rate limit: 10 req/s with 100ms delay between batches

### 8.3 Image Processing

```
Generated design (1024×1024)
  → Background removal (existing)
  → Upscale to 1000px wide / 300 DPI
  → Store as transparent PNG in S3
  → Ready for mockup composite or Shopify upload
```

### 8.4 Mockup Compositing (Sharp)

```
Input: transparent design PNG + blank shirt photo + print zone config
Process: Sharp overlay at configured coordinates with resize to fit zone
Output: Composite mockup image → S3
```

### 8.5 Shopify Product Creation

```
1. Build variant matrix: Color × Size × Price tier
2. Upload mockup images (from S3 URLs)
3. POST /admin/api/2024-01/products.json
4. Store product ID + handle
5. Return live URL
```

---

## Part 9: What Is NOT Being Built

| Feature | Status | Reason |
|---|---|---|
| AI image editing | Not used | PO decision |
| N8N workflow | Not used | Built-in state machine |
| Auto-scheduled Niche Hunter | Deferred (Phase J) | Manual for v1 |
| Admin credential UI | Deferred (Phase J) | Via chat for now |
| Sales analytics | Deferred (Phase J) | Future |
| NYT post-production (revision/mockup/Shopify) | Deferred (Phase J) | Can enable later |

---

## Part 10: Risk Mitigation

| Risk | Mitigation |
|---|---|
| Etsy API rate limits | Cache results, max 50 listings per scan, 100ms delay |
| Cross-niche scan finds irrelevant patterns | LLM filters for "transferable" patterns only; user can dismiss |
| GPT Image revision quality | Unlimited iterations + revert to original |
| Sharp composite misalignment | User-defined print zone; adjustable per template |
| Shopify 100-variant limit | 10 colors × 8 sizes = 80 (within limit). Cap at 12 colors. |
| NYT pipeline breaks during migration | workspaceId column is nullable; existing data gets default workspace ID |

---

*This plan is complete. All decisions locked. Ready for Phase A implementation.*
