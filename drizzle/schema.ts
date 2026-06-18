import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  boolean,
  json,
  decimal,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Pipeline run tracking. Each row = one execution of the 7-stage pipeline.
 */
export const botRuns = mysqlTable("bot_runs", {
  id: int("id").autoincrement().primaryKey(),
  status: mysqlEnum("status", ["running", "completed", "failed"]).default("running").notNull(),
  currentStage: int("currentStage").default(0).notNull(),
  totalStages: int("totalStages").default(7).notNull(),
  stageLabel: varchar("stageLabel", { length: 255 }).default("Initializing...").notNull(),
  booksProcessed: int("booksProcessed").default(0).notNull(),
  imagesGenerated: int("imagesGenerated").default(0).notNull(),
  topPickTitle: varchar("topPickTitle", { length: 512 }),
  topPickIsbn: varchar("topPickIsbn", { length: 64 }),
  errorLog: text("errorLog"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  lastHeartbeat: timestamp("lastHeartbeat"),
  /** Phase F: workspace that triggered this run (null for legacy NYT runs) */
  workspaceId: varchar("workspaceId", { length: 36 }),
});

export type BotRun = typeof botRuns.$inferSelect;
export type InsertBotRun = typeof botRuns.$inferInsert;

/**
 * Books extracted from the NYT Best Sellers list during a pipeline run.
 */
export const books = mysqlTable("books", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("runId").notNull(),
  title: varchar("title", { length: 512 }).notNull(),
  author: varchar("author", { length: 512 }).notNull(),
  isbn: varchar("isbn", { length: 64 }),
  coverUrl: text("coverUrl"),
  synopsis: text("synopsis"),
  rank: int("rank"),
  weeksOnList: int("weeksOnList"),
  // AI-extracted metadata
  dominantColors: json("dominantColors").$type<string[]>(),
  mood: varchar("mood", { length: 255 }),
  setting: varchar("setting", { length: 255 }),
  subgenre: varchar("subgenre", { length: 255 }),
  visualMotifs: json("visualMotifs").$type<string[]>(),
  typographyStyle: varchar("typographyStyle", { length: 255 }),
  /** v2: Fan community identity summary from extraction */
  fanCulture: text("fanCulture"),
  // Trend scores (0-100 each, total 0-300)
  trendScoreTotal: int("trendScoreTotal"),
  socialMomentum: int("socialMomentum"),
  socialRationale: text("socialRationale"),
  designNovelty: int("designNovelty"),
  designRationale: text("designRationale"),
  audienceSize: int("audienceSize"),
  audienceRationale: text("audienceRationale"),
  /** v3: Trend direction vs previous run (up/down/stable/new) */
  trendDirection: mysqlEnum("trendDirection", ["up", "down", "stable", "new"]).default("new"),
  /** v3: Previous run's total trend score for delta calculation */
  previousTrendScore: int("previousTrendScore"),
  /** v3: Score delta (current - previous), null if new */
  scoreDelta: int("scoreDelta"),
  /** v3: Previous run's rank for comparison */
  previousRank: int("previousRank"),
  /** v3: How many consecutive runs this book has appeared */
  streakCount: int("streakCount").default(1),
  /** v4: Real forum scraping results per source */
  forumSignals: json("forumSignals").$type<{
    reddit?: { postCount: number; avgUpvotes: number; topSubreddits: string[]; sampleTitles: string[]; status: "success" | "failed" | "skipped" };
    goodreads?: { ratingsCount: number; avgRating: number; reviewCount: number; topShelves: string[]; status: "success" | "failed" | "skipped" };
    storyGraph?: { moods: string[]; pace: string; themes: string[]; status: "success" | "failed" | "skipped" };
    fable?: { clubCount: number; discussionCount: number; status: "success" | "failed" | "skipped" };
    bookRiot?: { articleCount: number; articleTitles: string[]; status: "success" | "failed" | "skipped" };
  }>(),
  /** v5: World Bible — IP visual universe data extracted in Stage 2 for use in Stage 6 image generation */
  worldBible: json("worldBible").$type<{
    illustratorStyle: string;
    keyVisualEnvironments: string[];
    keyObjects: string[];
    lightingSignature: string;
    textureLanguage: string;
    typographyNative: string;
    emotionalTone: string;
    colorAnchors: string[];
  }>(),
  /** v4: Last time this book was individually refreshed */
  refreshedAt: timestamp("refreshedAt"),
  /** Style Intelligence: per-book computed style directives for image generation */
  styleDirectives: json("styleDirectives").$type<import("../shared/styleProfile").StyleProfile>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Book = typeof books.$inferSelect;
export type InsertBook = typeof books.$inferInsert;

/**
 * v2: Niche research results per book per run.
 * Stores the 3 research outputs: fan conversations, design styles, white space.
 */
export const nicheResearch = mysqlTable("niche_research", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("runId").notNull(),
  bookId: int("bookId").notNull(),
  /** Jokes, slogans, inside comments, identity markers, pain points */
  fanConversations: json("fanConversations").$type<{
    insideJokes: string[];
    slogans: string[];
    communityReferences: string[];
    painPoints: string[];
    identityMarkers: string[];
  }>(),
  /** Resonating styles, palettes, typography, formats, aesthetics */
  designStyles: json("designStyles").$type<{
    colorPalettes: string[];
    typographyPreferences: string[];
    artStyles: string[];
    formatPreferences: string[];
    aestheticMovements: string[];
  }>(),
  /** Untapped angles, missing formats, oversaturated areas */
  whiteSpace: json("whiteSpace").$type<{
    untappedHumorAngles: string[];
    ignoredSubAudiences: string[];
    missingFormats: string[];
    crossFandomOpportunities: string[];
    oversaturated: string[];
    fresh: string[];
  }>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type NicheResearch = typeof nicheResearch.$inferSelect;
export type InsertNicheResearch = typeof nicheResearch.$inferInsert;

/**
 * AI-generated design concepts for print-on-demand products.
 * v2: Each book gets 5 concepts (one per humor framework).
 */
export const designConcepts = mysqlTable("design_concepts", {
  id: int("id").autoincrement().primaryKey(),
  bookId: int("bookId").notNull(),
  runId: int("runId").notNull(),
  conceptName: varchar("conceptName", { length: 255 }).notNull(),
  format: varchar("format", { length: 100 }).notNull(),
  style: varchar("style", { length: 512 }).notNull(),
  headline: varchar("headline", { length: 512 }),
  subtext: varchar("subtext", { length: 512 }),
  colorPalette: json("colorPalette").$type<string[]>(),
  layoutDescription: text("layoutDescription"),
  fontSuggestion: varchar("fontSuggestion", { length: 255 }),
  copyrightSafe: boolean("copyrightSafe").default(true).notNull(),
  isFavorite: boolean("isFavorite").default(false).notNull(),
  /** v2: Which humor/concept framework was used */
  humorFramework: varchar("humorFramework", { length: 512 }),
  /** v3: Whether this concept is a global top-5 winner (gets 3 images) */
  isWinner: boolean("isWinner").default(false).notNull(),
  /** v3: Global rank among all concepts in this run (1 = best) */
  globalRank: int("globalRank"),
  /** Image variation 1: Clean/Commercial style */
  imageUrlA: text("imageUrlA"),
  /** Image variation 2: Bold/Artistic style */
  imageUrlB: text("imageUrlB"),
  /** Image variation 3: Trending/Social style */
  imageUrlC: text("imageUrlC"),
  /** Prompt used for variation 1 */
  imagePromptA: text("imagePromptA"),
  /** Prompt used for variation 2 */
  imagePromptB: text("imagePromptB"),
  /** Prompt used for variation 3 */
  imagePromptC: text("imagePromptC"),
  /** v2: Concept-level trend score (0-300) from niche-evidence scoring */
  trendScore: int("trendScore"),
  /** v2: FK to niche_research row that informed this concept */
  nicheResearchId: int("nicheResearchId"),
  /** v4: Source of this concept — full pipeline run or per-book refresh */
  refreshSource: mysqlEnum("refreshSource", ["full_run", "book_refresh"]).default("full_run"),
  /** v5: Cross-source signal tags that informed this concept (from forum overlap analysis) */
  signalTags: json("signalTags").$type<string[]>(),
  /** v6: The real fan phrase/quote this concept is anchored to */
  sourcePhrase: text("sourcePhrase"),
  /** Phase 3: FK to trend_patterns.id when concept was created from an approved niche pattern */
  nichePatternId: varchar("nichePatternId", { length: 36 }),
  /** v4: Cached production-ready transparent PNG URLs */
  productionUrlA: text("productionUrlA"),
  productionUrlB: text("productionUrlB"),
  productionUrlC: text("productionUrlC"),
  /** Per-DESIGN print placement (PO 2026-06-12), keyed by product-group id. The Mockup studio's
   *  Manual Placement saves HERE — scoped to this concept — and overrides at generate time. It must
   *  NEVER touch the product group's per-colour calibration (template.garmentBbox), which the studio
   *  used to overwrite (the "Product Group changes not persistent" bug). */
  printPlacements: json("printPlacements").$type<Record<string, { x: number; y: number; width: number; height: number }>>(),
  /** Dismiss → signal (PO 2026-06-15): when set, the buyer rejected this scan design. Its rejectionTags
   *  feed the NEXT scan's council avoidDirectives, exactly like a dismissed trend_pattern. Reversible. */
  dismissedAt: timestamp("dismissedAt"),
  rejectionTags: json("rejectionTags").$type<string[]>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DesignConcept = typeof designConcepts.$inferSelect;
export type InsertDesignConcept = typeof designConcepts.$inferInsert;

/**
 * v2: Etsy market validation data per design concept.
 */
export const marketValidation = mysqlTable("market_validation", {
  id: int("id").autoincrement().primaryKey(),
  conceptId: int("conceptId").notNull(),
  etsyListingCount: int("etsyListingCount"),
  avgPrice: decimal("avgPrice", { precision: 10, scale: 2 }),
  minPrice: decimal("minPrice", { precision: 10, scale: 2 }),
  maxPrice: decimal("maxPrice", { precision: 10, scale: 2 }),
  topFavorites: int("topFavorites"),
  saturationLevel: mysqlEnum("saturationLevel", [
    "low",
    "medium",
    "high",
    "unavailable",
  ]).default("unavailable").notNull(),
  searchKeywords: varchar("searchKeywords", { length: 512 }),
  validatedAt: timestamp("validatedAt").defaultNow().notNull(),
});

export type MarketValidation = typeof marketValidation.$inferSelect;
export type InsertMarketValidation = typeof marketValidation.$inferInsert;


/**
 * Self-healing log — records all auto-recovery actions taken by the system.
 * Inspired by ClawHub self-healing-agent + memory-self-heal patterns.
 */
export const healingLog = mysqlTable("healing_log", {
  id: int("id").autoincrement().primaryKey(),
  subsystem: varchar("subsystem", { length: 50 }).notNull(), // 'pipeline', 'api', 'frontend', 'db', 'network'
  issue: text("issue").notNull(),
  classification: varchar("classification", { length: 50 }), // failure class from memory-self-heal
  diagnosis: text("diagnosis"),
  actionTaken: text("actionTaken"),
  result: mysqlEnum("result", ["success", "fallback", "escalated"]).notNull(),
  mttrSeconds: int("mttrSeconds"), // mean time to recovery
  runId: int("runId"), // nullable, links to bot_runs if pipeline-related
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type HealingLog = typeof healingLog.$inferSelect;
export type InsertHealingLog = typeof healingLog.$inferInsert;

/**
 * Workspaces — each workspace is an isolated research + design vertical.
 * Phase A: Foundation
 */
export const workspaces = mysqlTable("workspaces", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  icon: varchar("icon", { length: 10 }).default("🎯").notNull(),
  workspaceType: mysqlEnum("workspaceType", ["nyt", "niche_hunter"]).notNull(),
  ownerId: varchar("ownerId", { length: 64 }).notNull(),
  nicheProfile: json("nicheProfile").$type<Record<string, unknown>>(),
  pipelineConfig: json("pipelineConfig").$type<{
    topicsPerScan: number;
    conceptsPerTopic: number;
    winnersToGenerate: number;
    variationsPerWinner: number;
  }>(),
  descriptionTemplate: text("descriptionTemplate"),
  /** Style Intelligence: computed visual style directives for image generation */
  styleProfile: json("styleProfile").$type<import("../shared/styleProfile").StyleProfile>(),
  /** Style Intelligence: user-set override fields that lock specific style parameters */
  styleOverride: json("styleOverride").$type<Partial<import("../shared/styleProfile").StyleProfile>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;

/**
 * Per-workspace encrypted credentials (Shopify token, Etsy keys, etc.)
 */
export const workspaceCredentials = mysqlTable("workspace_credentials", {
  id: varchar("id", { length: 36 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  credKey: varchar("credKey", { length: 100 }).notNull(),
  credValue: text("credValue").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type WorkspaceCredential = typeof workspaceCredentials.$inferSelect;
export type InsertWorkspaceCredential = typeof workspaceCredentials.$inferInsert;

/**
 * Product groups — a named collection of blank mockup templates (e.g., "Comfort Colors 1717").
 * Each workspace can have multiple product groups.
 */
export const productGroups = mysqlTable("product_groups", {
  id: varchar("id", { length: 36 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  description: text("description"),
  /** Product type label used in listing titles, e.g. "T-Shirt", "Crewneck", "Hoodie" */
  productType: varchar("productType", { length: 100 }).default("T-Shirt"),
  compareAtPrice: decimal("compareAtPrice", { precision: 10, scale: 2 }),
  /** DEPRECATED 2026-06-11: cost is now PER pricing tier (pricingTiers[].cost) — COGS varies by size.
   *  Column kept unused (no drop-migration); the per-tier cost in the JSON below is the source of truth. */
  costPerItem: decimal("costPerItem", { precision: 10, scale: 2 }),
  /** JSON: [{sizes:["S","M","L","XL"], price:34.95, cost:8.50, compareAt:49.95}, ...] — per tier:
   *  price = sale, cost = COGS, compareAt = strikethrough MSRP. */
  pricingTiers: json("pricingTiers").$type<Array<{ sizes: string[]; price: number; cost?: number; compareAt?: number }>>(),
  /** Per-INDIVIDUAL-SIZE shipping weight in oz, e.g. {"S":5.2,"M":5.6,...} — sent to Shopify as the
   *  variant weight. Per size, not per tier (a 4XL weighs more than an S). PO 2026-06-11. */
  sizeWeights: json("sizeWeights").$type<Record<string, number>>(),
  /** Shopify product taxonomy category GID (e.g. "gid://shopify/TaxonomyCategory/aa-1-13-8" = T-Shirts).
   *  Sent on export — required before swatches can link. Null → T-Shirts default. PO 2026-06-11. */
  shopifyCategoryGid: varchar("shopifyCategoryGid", { length: 120 }),
  /** Shopify category metafields (PO 2026-06-12) — GARMENT facts, constant per group (the blank),
   *  set once (LLM pre-fill + human confirm) and auto-sent on every export as taxonomy metafields. */
  categoryAttributes: json("categoryAttributes").$type<{
    ageGroup?: string;          // e.g. "Adults"
    neckline?: string;          // e.g. "Crew"
    sleeveLengthType?: string;  // e.g. "Short sleeve"
    targetGender?: string;      // e.g. "Unisex"
    topLengthType?: string;     // e.g. "Regular"
    careInstructions?: string[]; // e.g. ["Machine wash cold","Tumble dry low"]
    fabric?: string;            // e.g. "100% ring-spun cotton"
    clothingFeatures?: string[]; // e.g. ["Relaxed fit"]
  }>(),
  /** Print zone — photo-relative ratios 0-1. x/y/width/height = the GROUP-level fallback box
   * (used when a color template has no per-template box). widthIn/heightIn = the real-world MAX
   * print-area size in INCHES (shared per group; the editor aspect-locks each box to this).
   * ADDITIVE $type widening 2026-06-09 (TS-only, no DDL — JSON column unchanged). */
  printZone: json("printZone").$type<{ x: number; y: number; width: number; height: number; widthIn?: number; heightIn?: number }>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type ProductGroup = typeof productGroups.$inferSelect;
export type InsertProductGroup = typeof productGroups.$inferInsert;

/**
 * Mockup templates — individual blank product photos within a group.
 * Each row = one shirt color with its photo URL, available sizes, and color metadata.
 */
export const mockupTemplates = mysqlTable("mockup_templates", {
  id: varchar("id", { length: 36 }).primaryKey(),
  groupId: varchar("groupId", { length: 36 }).notNull(),
  colorName: varchar("colorName", { length: 100 }).notNull(),
  colorHex: varchar("colorHex", { length: 7 }).notNull().default("#000000"),
  imageUrl: text("imageUrl").notNull(),
  imageKey: varchar("imageKey", { length: 500 }).notNull(),
  /** JSON: ["S","M","L","XL","2XL","3XL"] */
  availableSizes: json("availableSizes").$type<string[]>().notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  /** PER-TEMPLATE PRINT AREA (repurposed 2026-06-09). Photo-relative ratios 0-1 = the print
   * rectangle the human calibrated on THIS color's own photo (client API field name: printArea).
   * Resolved first by resolvePrintZone (template box → group.printZone → DEFAULT). Null = this
   * color not yet calibrated (falls back to the group zone).
   * NOTE: column kept named `garmentBbox` (NO rename) to keep the shared tsc gate green; the
   * old vision-LLM bbox meaning is dead. One-time NULL-clear of stale vision boxes is a deploy
   * prerequisite so they don't win the fallback. (A later cosmetic rename can align the name.) */
  garmentBbox: json("garmentBbox").$type<{ x: number; y: number; width: number; height: number }>(),
  /** Best-seller blank (PO 2026-06-12, e.g. Espresso for Comfort Colors): when the design is
   *  READABLE on it, the colour matcher always includes it in the picked set. */
  isBestSeller: boolean("isBestSeller").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MockupTemplate = typeof mockupTemplates.$inferSelect;
export type InsertMockupTemplate = typeof mockupTemplates.$inferInsert;

/**
 * Niche Hunter scan runs — one row per triggered scan.
 * Phase E: Niche Hunter
 */
export const nicheScanRuns = mysqlTable("niche_scan_runs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
  status: mysqlEnum("status", ["running", "completed", "failed"]).default("running").notNull(),
  /** 0-100 progress percentage */
  progress: int("progress").default(0).notNull(),
  patternsFound: int("patternsFound").default(0).notNull(),
  errorLog: text("errorLog"),
  /** Array of {query, url, filter, resultCount, searchedAt} — one entry per Etsy URL pinged */
  searchLog: json("searchLog").$type<Array<{
    query: string;
    url: string;
    filter: "is_best_seller" | "is_popular_now";
    resultCount: number;
    searchedAt: string; // ISO timestamp
  }>>(),
  /** Concept mode for this scan (PO Option C, 2026-06-08).
   *  'auto'    — brain picks the concept and generates the image (hands-off, fast).
   *  'curated' — brain proposes concept options per source and STOPS; the human picks
   *              one (chooseConceptAndGenerate) before any image is generated. */
  conceptMode: mysqlEnum("conceptMode", ["auto", "curated"]).default("auto").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type NicheScanRun = typeof nicheScanRuns.$inferSelect;
export type InsertNicheScanRun = typeof nicheScanRuns.$inferInsert;

/**
 * Trend patterns — discovered design patterns from Niche Hunter scans.
 * Each row = one transferable pattern found from a hot-selling listing.
 * Phase E: Niche Hunter
 */
export const trendPatterns = mysqlTable("trend_patterns", {
  id: varchar("id", { length: 36 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
  scanId: varchar("scanId", { length: 36 }),
  sourcePlatform: varchar("sourcePlatform", { length: 20 }), // 'etsy' | 'reddit'
  sourceTitle: text("sourceTitle"),
  /** Direct URL to the real Etsy listing that inspired this pattern */
  sourceUrl: text("sourceUrl"),
  sourceImageUrl: text("sourceImageUrl"),
  sourceSales: int("sourceSales"),
  sourceBadge: varchar("sourceBadge", { length: 30 }),
  sourceScrapedAt: timestamp("sourceScrapedAt"),
  sourceReviewCount: int("sourceReviewCount"),
  /** Short name for this pattern, e.g. "Gorilla + Activity Absurdism" */
  patternName: varchar("patternName", { length: 200 }).notNull(),
  /** Layout/composition style, e.g. "centered character, bold text below" */
  composition: text("composition"),
  /** Color approach, e.g. "2-color vintage wash" */
  colorStrategy: text("colorStrategy"),
  /** Why buyers love it emotionally */
  emotionalHook: text("emotionalHook"),
  /** How this pattern can be adapted for the target niche */
  transferablePattern: text("transferablePattern"),
  /** LLM explanation of why this works */
  whyItWorks: text("whyItWorks"),
  /** Adapted concept idea for the target niche */
  adaptedConcept: text("adaptedConcept"),
  /** AI-generated preview image URL for the adapted concept */
  previewImageUrl: text("previewImageUrl"),
  /** Ranking score (0-100) based on market fit, originality, niche alignment */
  score: int("score"),
  /** LLM explanation of why this pattern scored the way it did */
  rankReasoning: text("rankReasoning"),
  /** Source niche category this pattern was adapted FROM, e.g. "Fishing", "Yoga Cats" */
  sourceCategory: varchar("sourceCategory", { length: 100 }),
  /** Whether the pun/hook survives the niche transfer (false = auto-dismissed) */
  transferValid: boolean("transferValid").default(true),
  /** LLM explanation of why the transfer passed or failed */
  transferReasoning: text("transferReasoning"),
  status: mysqlEnum("status", ["discovered", "approved", "dismissed"]).default("discovered").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  // ─── Style-Faithful Pipeline additions ───────────────────────────────────
  /** Vision LLM style extraction from source Etsy image */
  sourceStyleJson: json("sourceStyleJson"),
  /** Generation mode selected by LLM: edit_source | style_reference | prompt_only */
  adaptationMode: varchar("adaptationMode", { length: 40 }),
  /** User reason for approving this pattern */
  approvalReason: text("approvalReason"),
  /** User reason for dismissing this pattern */
  rejectionReason: text("rejectionReason"),
  /** Structured approval tags: great_style, perfect_subject, etc. */
  approvalTags: json("approvalTags").$type<string[]>(),
  /** Structured rejection tags: wrong_style, bad_subject, etc. */
  rejectionTags: json("rejectionTags").$type<string[]>(),
  /** When the pattern was approved */
  approvedAt: timestamp("approvedAt"),
  /** When the pattern was dismissed */
  dismissedAt: timestamp("dismissedAt"),
  /** Production-ready transparent PNG, generated only after approval */
  dtfImageUrl: text("dtfImageUrl"),
  /** Standalone transparent PNG of the design artwork only (no shirt). Generated via images.generate + magenta chromakey.
   *  This is the canonical asset. previewImageUrl = compositor(productionDesignUrl + template). dtfImageUrl = upscale(productionDesignUrl). */
  productionDesignUrl: text("productionDesignUrl"),
  /** Count of failed processPatternProduction attempts via retryStuckPatterns. Incremented
   *  on each catch; after MAX_PRODUCTION_ATTEMPTS the pattern is auto-dismissed with
   *  rejectionTags=['transfer_failed']. Prevents the infinite-retry loop (Manus PO confirmed:
   *  a permanently-failing pattern was stuck for 4 hours because retryStuckPatterns logged
   *  the error but never gave up). Default 0 = fresh budget on insert. */
  productionAttempts: int("productionAttempts").default(0).notNull(),
  /** Concurrency lease for retryStuckPatterns. The frontend polls retryStuckPatterns
   *  every 15s but each call takes minutes, so polls overlap and used to grab the SAME
   *  stuck pattern concurrently — processing it 2-3x (duplicate gpt-image-1 cost) and
   *  producing contradictory validationReport-vs-status rows (PO-confirmed 2026-06-07).
   *  A pattern is atomically claimed (claimedAt = now via conditional UPDATE) before
   *  processing; concurrent claimers see affectedRows=0 and skip it. Cleared on
   *  non-dismiss failure (immediate retry) and ignored once productionDesignUrl is set
   *  or status=dismissed (pattern leaves the queue). A 5-min staleness window lets a
   *  pattern recover if its claimer was killed mid-process (Cloud Run). */
  claimedAt: timestamp("claimedAt"),
  /** Array of per-shirt-color previews. Each entry is the productionDesignUrl composited
   *  onto one workspace mockup template, with shirt-aware halftone+knockout tuned to that
   *  template's colorHex (so the design integrates with the fabric instead of looking like
   *  a plastic decal). PO insight: halftone is shirt-color-dependent — the dot pattern lets
   *  the shirt color show through, so each template gets its own tuned preview.
   *  Null on legacy patterns; previewImageUrl above stays populated for backward UI compat. */
  previewImageUrls: json("previewImageUrls").$type<Array<{ templateId: string; colorHex: string; colorName: string; previewUrl: string }>>(),
  /** Output validation report — vision-LLM audit of the generated design BEFORE storagePut.
   *  Catches the failure modes the existing pipeline didn't notice: off-niche designs
   *  scoring high (Don't Be Afraid dandelion scored 85), gpt-image-1 typography typos
   *  (PART/PARK, RFICHEN/KITCHEN), and brain-plan vs image-output drift (raccoon image
   *  labeled T-Rex). When shouldShip=false the pattern is auto-dismissed before
   *  storagePut. Foundational fix — every layer of the pipeline was trusting the
   *  previous layer's output without verification. */
  validationReport: json("validationReport").$type<{
    nicheRelevance: number;
    matchesPlan: boolean;
    textInImage: string;
    textMatchesPlan: boolean;
    hasTypo: boolean;
    shouldShip: boolean;
    reasoning: string;
  }>(),
  /** Curated mode (PO Option C, 2026-06-08): the 2-3 concept proposals the brain
   *  generated for this source. The human picks one before any image is generated.
   *  Null in auto mode (the brain picks + generates directly). */
  conceptOptions: json("conceptOptions").$type<Array<{ title: string; summary: string }>>(),
  /** The concept the human picked from conceptOptions (curated mode). Seeds
   *  nicheExpertPlan so it writes the edit prompt FOR this concept instead of
   *  re-choosing. Null until the human chooses (or in auto mode). */
  chosenConcept: text("chosenConcept"),
  /** Curated mode race-guard (PO-confirmed bug 2026-06-08): set TRUE atomically at
   *  pattern creation in a curated scan, so retryStuckPatterns excludes it from
   *  auto-generation from the very first instant. Concept options are proposed at
   *  scan-END, so a curated pattern exists option-less for minutes during the scan;
   *  without this flag, the background straggler-drain grabbed and auto-generated it
   *  before its options were set. Stays true; the `!chosenConcept` guard makes it
   *  eligible again once the human picks. False for all auto-mode patterns. */
  awaitingConcept: boolean("awaitingConcept").default(false).notNull(),
});

export type TrendPattern = typeof trendPatterns.$inferSelect;
export type InsertTrendPattern = typeof trendPatterns.$inferInsert;

/**
 * Phase H: Mockup renders — composited design-on-shirt images.
 * Each row = one composite of a concept variation on a specific mockup template.
 */
export const mockupRenders = mysqlTable("mockup_renders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  conceptId: int("conceptId").notNull(),
  variationKey: varchar("variationKey", { length: 1 }).notNull(),
  templateId: varchar("templateId", { length: 36 }).notNull(),
  compositeUrl: text("compositeUrl").notNull(),
  /** Which design revision this composite was generated from (PO 2026-06-17, per-design identity).
   *  NULL = legacy / live-slot semantics (uses concept.imageUrlA at the time). Setting this lets
   *  multiple versions' mockups coexist instead of one overwriting the other. */
  sourceRevisionId: varchar("sourceRevisionId", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MockupRender = typeof mockupRenders.$inferSelect;
export type InsertMockupRender = typeof mockupRenders.$inferInsert;

/**
 * Print files — persisted index of downloadable print-ready exports (PO 2026-06-17, "where are the
 * stored downloadable print files?"). Each row = one generated print asset (full-tone DTF, halftone,
 * or knockout) for a concept version. The actual PNG lives in S3 (url); this row makes it findable.
 */
export const printFiles = mysqlTable("print_files", {
  id: varchar("id", { length: 36 }).primaryKey(),
  conceptId: int("conceptId").notNull(),
  variationKey: varchar("variationKey", { length: 1 }).notNull(),
  /** Which design version this was exported from (null = live slot). */
  sourceRevisionId: varchar("sourceRevisionId", { length: 36 }),
  /** fulltone (DTF, print as-is) | halftone (single-ink screen/vintage) | knockout (shirt shows through) */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** Ink color for halftone, or the knocked-out color for knockout. NULL for fulltone. */
  inkColor: varchar("inkColor", { length: 24 }),
  url: text("url").notNull(),
  filename: varchar("filename", { length: 200 }).notNull(),
  widthPx: int("widthPx").notNull(),
  heightPx: int("heightPx").notNull(),
  dpi: int("dpi").notNull().default(300),
  /** SHA-256 of the PNG bytes — dedupe identical exports so the library + S3 don't balloon. */
  contentHash: varchar("contentHash", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PrintFile = typeof printFiles.$inferSelect;
export type InsertPrintFile = typeof printFiles.$inferInsert;

/** Phase G: Design revision iteration history */
export const designRevisions = mysqlTable("design_revisions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  conceptId: int("conceptId").notNull(),
  variationKey: varchar("variationKey", { length: 1 }).notNull(),
  iterationNumber: int("iterationNumber").notNull().default(1),
  instruction: text("instruction"),
  referenceImageUrl: text("referenceImageUrl"),
  resultImageUrl: text("resultImageUrl").notNull(),
    accepted: boolean("accepted").notNull().default(false),
  dismissedAt: timestamp("dismissedAt"),
  rejectionTags: json("rejectionTags").$type<string[]>(),
  /** User-editable label for this design version (PO 2026-06-17, per-design identity).
   *  Each card in the "Previous versions" gallery can be renamed so the PO can tell which
   *  llama is which. Default is derived from style + index in the UI when NULL. */
  name: varchar("name", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type DesignRevision = typeof designRevisions.$inferSelect;
export type InsertDesignRevision = typeof designRevisions.$inferInsert;

/**
 * Shopify Listings — Phase I: tracks listing drafts created from mockups.
 * Each row = one listing draft ready for export to Shopify.
 */
export const shopifyListings = mysqlTable("shopify_listings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
  conceptId: int("conceptId").notNull(),
  /** The product group used for pricing/sizing */
  productGroupId: varchar("productGroupId", { length: 36 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  tags: json("tags").$type<string[]>(),
  /** Price in dollars */
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  compareAtPrice: decimal("compareAtPrice", { precision: 10, scale: 2 }),
  /** JSON array of mockup render IDs used as product images */
  mockupRenderIds: json("mockupRenderIds").$type<string[]>().notNull(),
  /** Status: draft → ready → exported */
  status: mysqlEnum("listingStatus", ["draft", "ready", "exported"]).default("draft").notNull(),
  /** Shopify product ID once exported */
  shopifyProductId: varchar("shopifyProductId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ShopifyListing = typeof shopifyListings.$inferSelect;
export type InsertShopifyListing = typeof shopifyListings.$inferInsert;
