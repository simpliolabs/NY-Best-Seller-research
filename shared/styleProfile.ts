/**
 * StyleProfile — computed visual style directives for image generation.
 * Derived by the Style Intelligence layer from niche research, trend patterns,
 * and book world bibles. Can be overridden per-workspace.
 */
export interface StyleProfile {
  /** Primary aesthetic direction, e.g. "vintage screen-print", "modern minimal", "hand-drawn organic" */
  primaryAesthetic: string;
  /** Color palette guidance, e.g. "muted earth tones — burnt orange, forest green, cream, charcoal" */
  colorDirective: string;
  /** Max ink colors for DTF (2-4 for vintage, 4-6 for modern) */
  maxColors: number;
  /** Texture/distress level: "heavy-vintage" | "moderate-worn" | "clean-modern" | "hand-drawn" */
  textureLevel: string;
  /** Preferred composition types: "badge-emblem", "typography-forward", "illustration-centered", "scattered-layout" */
  compositionPreferences: string[];
  /** Typography style: "distressed-serif", "bold-condensed-sans", "hand-lettered", "retro-script" */
  typographyStyle: string;
  /** What to AVOID — anti-patterns for this niche/book */
  avoidDirectives: string[];
  /** What top sellers in this space look like — market context for the LLM */
  marketReference: string;
  /** How this profile was produced */
  source: "computed" | "override" | "hybrid";
  /** Art-style allowlist the concept council may choose each concept's style from (curated in
   *  Workspace Settings, seeded on creation). Cartoonish is intentionally excluded. */
  allowedStyles?: string[];
}

/** Default art-style menu seeded onto new workspaces (PO 2026-06-09). Cartoonish, Photorealistic,
 *  and thin-line styles (Minimalist Line-Art, Vintage Engraving) excluded — DTF can't print hairline
 *  strokes, cross-hatching, or stippling (PO 2026-06-16). Also the options shown in the per-concept
 *  Regenerate dropdown. */
export const DEFAULT_ALLOWED_STYLES: string[] = [
  "Vintage/Distressed",
  "Retro 70s-80s",
  "Halftone Screen-Print",
  "Bold Typographic",
  "Dark Academia",
  "Collegiate/Varsity",
  "Cottagecore",
  "Streetwear/Y2K",
  "Watercolor",
  "Militarycore",
  // Added from LIVE Etsy "funny graphic shirts" best-sellers (PO 2026-06-09).
  "Vintage 90's",
  "Vintage Hand-Drawn Illustration",
  "Western Americana",
  "Cabincore",
  "Retro Groovy",
];

/** STYLE PLAYBOOK — the authoritative one-line visual description per style. Single source of truth
 *  shared by (a) the design council's NICHE_COUNCIL_SYSTEM playbook section and (b) the per-concept
 *  regenerate prompt in routers.ts (so the dropdown's style choice actually steers the render rather
 *  than fighting stale concept metadata). PO 2026-06-16. */
export const STYLE_PLAYBOOK: Record<string, string> = {
  "Vintage/Distressed": "heavy worn cracked screen-print, chunky halftone grit (rendered as solid dot shapes, never thin mesh), ink-pull imperfections on thickly-weighted strokes, faded retro palette (cream/burnt-orange/mustard/forest/charcoal). 1970s park-tee feel.",
  "Vintage Hand-Drawn Illustration": "organic hand-drawn illustration with BOLD ink line work — every outline a thick confident brush stroke (never hairline), slight imperfections, hand-drawn feel, muted vintage palette, illustrative not graphic.",
  "Retro 70s-80s": "groovy bubble/funk type, sunbursts, rainbow gradients within a limited 70s palette, warm browns/oranges/yellows, optimistic and graphic.",
  "Retro Groovy": "70s psychedelic — wavy custom lettering, hippie palette, swirling forms, looser and more decorative than Retro 70s-80s.",
  "Vintage 90's": "90s sports/streetwear — bold geometric blocks, color-block panels, varsity-meets-graffiti energy, primary palette + black.",
  "Western Americana": "rope/wood-cut decorative borders, hand-lettered Old-West/saloon serifs, dusty sepia + denim palette, cowboy/desert motifs.",
  "Cabincore": "cozy folk-art, pine/forest/cabin/mushroom motifs, warm muted earth tones; rugged outdoors.",
  "Cottagecore": "cozy folk-art, soft pastoral florals/herbs, warm muted earth tones.",
  "Halftone Screen-Print": "clean punk/indie poster — bold flat shapes overlaid with prominent halftone dot patterns, high-contrast 2-color separations.",
  "Bold Typographic": "typography IS the design — chunky display lettering, modern type-forward; NO illustration, NO mascot, NO paddle/ball/court props, NO accent decorations (no stars, sparkles, sweat drops, dotted accents) — typography stands ALONE; high contrast, generous negative space (NOT a badge). If the concept seems to want an illustration, the council should have picked a different style — Bold Typographic is type-only by definition.",
  "Dark Academia": "oxblood/forest-green/cream palette, classical serifs and Latin-feel borders, books/owls/celestial motifs, scholarly elegance.",
  "Collegiate/Varsity": "classic varsity letterman — block/serif college type, arched headline + circular seal, school colors, athletic crest.",
  "Streetwear/Y2K": "brand-graphic energy — bold sans, glossy chrome/Y2K palette, modern hype-drop look.",
  "Watercolor": "soft hand-painted washes with bleeding edges, organic shapes, gentle muted palette, illustrative not graphic.",
  "Militarycore": "surplus / army-stencil — olive/khaki/black palette, stencil block lettering, weathered tag/patch look.",
};
