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

/** Default art-style menu seeded onto new workspaces (PO 2026-06-09). Cartoonish excluded; also
 *  the options shown in the per-concept Regenerate dropdown. */
export const DEFAULT_ALLOWED_STYLES: string[] = [
  "Vintage/Distressed",
  "Retro 70s-80s",
  "Halftone Screen-Print",
  "Bold Typographic",
  "Minimalist Line-Art",
  "Gritty Realism",
  "Photorealistic",
  "Dark Academia",
  "Collegiate/Varsity",
  "Cottagecore",
  "Streetwear/Y2K",
  "Watercolor",
  "Tactical/Militarycore",
  // Added from LIVE Etsy "funny graphic shirts" best-sellers (PO 2026-06-09).
  "Vintage 90's",
  "Vintage Hand-Drawn Illustration",
  "Western/Cowboy",
  "Outdoors/Cabincore",
  "Retro Groovy",
];
