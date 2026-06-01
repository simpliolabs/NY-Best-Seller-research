/**
 * Style Intelligence — derives visual style directives for image generation.
 *
 * Two entry points:
 *   computeBaseStyleProfile  — called ONCE at niche workspace creation (onboarding-time)
 *   computeRunStyleDirectives — called every pipeline run for both workspace types
 */

import { invokeLLM } from "./_core/llm";
import type { StyleProfile } from "../shared/styleProfile";
import type { TrendPattern } from "../drizzle/schema";
import type { NicheResearch } from "../drizzle/schema";

// ─── Onboarding-time: niche workspaces only ──────────────────────────────────

const BASE_STYLE_SYSTEM = `You are a print-on-demand market analyst specializing in visual style strategy for t-shirt brands.

Given a niche profile, derive the optimal visual style for t-shirt designs that will sell to this audience. Base your analysis on what ACTUALLY SELLS in this market — not generic design theory.

Consider:
- What do top Etsy sellers in this niche look like? (vintage/distressed? modern minimal? hand-drawn?)
- What color palettes dominate best-sellers? (muted earth tones? bold primaries? pastels? monochrome?)
- What texture level sells? (heavy-distressed/worn? clean-modern? hand-drawn organic?)
- What composition types dominate? (badge/emblem? typography-forward? illustration-centered? scattered?)
- What does this audience HATE? (clip-art? cartoonish? overly digital? corporate?)

Return ONLY a JSON object matching this schema exactly:
{
  "primaryAesthetic": "string — e.g. 'vintage screen-print', 'modern minimal', 'hand-drawn organic'",
  "colorDirective": "string — specific palette guidance e.g. 'muted earth tones: burnt orange, forest green, cream, charcoal — max 3 colors'",
  "maxColors": "integer 2-6",
  "textureLevel": "string — one of: heavy-vintage, moderate-worn, clean-modern, hand-drawn",
  "compositionPreferences": ["string array — e.g. 'badge-emblem', 'typography-forward'"],
  "typographyStyle": "string — e.g. 'distressed-serif', 'bold-condensed-sans', 'hand-lettered', 'retro-script'",
  "avoidDirectives": ["string array — what to avoid, e.g. 'clip-art cartoons', 'bright saturated colors', 'digital gradients'"],
  "marketReference": "string — 1-2 sentences describing what top sellers in this space look like",
  "source": "computed"
}`;

export async function computeBaseStyleProfile(
  nicheProfile: Record<string, unknown>
): Promise<StyleProfile> {
  const userMsg = `Niche profile:
Summary: ${nicheProfile.summary ?? "not specified"}
Target audience: ${nicheProfile.targetAudience ?? "not specified"}
Design styles that resonate: ${Array.isArray(nicheProfile.designStyles) ? (nicheProfile.designStyles as string[]).join(", ") : "not specified"}
Cross-niche categories: ${Array.isArray(nicheProfile.crossNicheCategories) ? (nicheProfile.crossNicheCategories as string[]).join(", ") : "not specified"}
Etsy keywords: ${Array.isArray(nicheProfile.etsyKeywords) ? (nicheProfile.etsyKeywords as string[]).join(", ") : "not specified"}
Topics to avoid: ${Array.isArray(nicheProfile.avoidTopics) ? (nicheProfile.avoidTopics as string[]).join(", ") : "none"}`;

  const result = await invokeLLM({
    messages: [
      { role: "system", content: BASE_STYLE_SYSTEM },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
  });

  const content = typeof result.choices[0]?.message?.content === "string"
    ? result.choices[0].message.content
    : "{}";

  const parsed = JSON.parse(content) as StyleProfile;
  return { ...parsed, source: "computed" };
}

// ─── Pipeline-time: both workspace types ─────────────────────────────────────

const RUN_STYLE_SYSTEM = `You are a print-on-demand visual style strategist. Your job is to synthesize research data into precise visual style directives for t-shirt image generation.

You will receive either:
- For niche workspaces: a base style profile + approved trend patterns + current niche research
- For NYT book workspaces: a book's world bible + niche research

Produce a final StyleProfile that:
1. Is grounded in what ACTUALLY SELLS in this market (not generic design theory)
2. Respects any locked override fields (do not change them)
3. Synthesizes pattern aesthetics into concrete directives
4. Gives the image generation AI specific, actionable constraints

Return ONLY a JSON object matching this schema exactly:
{
  "primaryAesthetic": "string",
  "colorDirective": "string",
  "maxColors": "integer 2-6",
  "textureLevel": "string — one of: heavy-vintage, moderate-worn, clean-modern, hand-drawn",
  "compositionPreferences": ["string array"],
  "typographyStyle": "string",
  "avoidDirectives": ["string array"],
  "marketReference": "string",
  "source": "computed"
}`;

interface RunStyleOptsNiche {
  workspaceType: "niche_hunter";
  baseProfile?: StyleProfile;
  override?: Partial<StyleProfile>;
  approvedPatterns: TrendPattern[];
  nicheResearch: NicheResearch[];
}

interface RunStyleOptsNyt {
  workspaceType: "nyt";
  book: {
    title: string;
    subgenre: string | null;
    mood: string | null;
    setting: string | null;
    fanCulture: string | null;
    worldBible?: {
      illustratorStyle: string;
      keyVisualEnvironments: string[];
      keyObjects: string[];
      lightingSignature: string;
      textureLanguage: string;
      typographyNative: string;
      emotionalTone: string;
      colorAnchors: string[];
    } | null;
  };
  nicheResearch?: NicheResearch;
}

export async function computeRunStyleDirectives(
  opts: RunStyleOptsNiche | RunStyleOptsNyt
): Promise<StyleProfile> {
  let userMsg: string;

  if (opts.workspaceType === "niche_hunter") {
    const patternSummary = opts.approvedPatterns.length > 0
      ? opts.approvedPatterns.map(p =>
          `- "${p.patternName}": composition=${p.composition ?? "n/a"}, colors=${p.colorStrategy ?? "n/a"}, hook=${p.emotionalHook ?? "n/a"}`
        ).join("\n")
      : "No approved patterns yet";

    const researchStyles = opts.nicheResearch.flatMap(nr =>
      (nr.designStyles as any)?.artStyles ?? []
    ).slice(0, 10);

    userMsg = `Workspace type: niche_hunter

BASE STYLE PROFILE (established at onboarding):
${opts.baseProfile ? JSON.stringify(opts.baseProfile, null, 2) : "Not yet computed — derive from patterns and research only"}

APPROVED TREND PATTERNS (reverse-engineered from top sellers):
${patternSummary}

NICHE RESEARCH — art styles that resonate with this community:
${researchStyles.length > 0 ? researchStyles.join(", ") : "not available"}

${opts.override ? `LOCKED OVERRIDE FIELDS (do not change these): ${JSON.stringify(opts.override)}` : "No overrides set"}

Synthesize the above into a single StyleProfile for this pipeline run.`;
  } else {
    const wb = opts.book.worldBible;
    const researchStyles = opts.nicheResearch
      ? (opts.nicheResearch.designStyles as any)?.artStyles ?? []
      : [];

    userMsg = `Workspace type: nyt (book)

BOOK: ${opts.book.title}
Subgenre: ${opts.book.subgenre ?? "unknown"}
Mood: ${opts.book.mood ?? "unknown"}
Setting: ${opts.book.setting ?? "unknown"}
Fan culture: ${opts.book.fanCulture ?? "unknown"}

WORLD BIBLE:
${wb ? `Illustrator style: ${wb.illustratorStyle}
Texture language: ${wb.textureLanguage}
Typography native: ${wb.typographyNative}
Emotional tone: ${wb.emotionalTone}
Color anchors: ${wb.colorAnchors.join(", ")}` : "Not yet computed"}

NICHE RESEARCH — art styles that resonate with this fandom:
${researchStyles.length > 0 ? researchStyles.join(", ") : "not available"}

IMPORTANT: Derive the style that would make MERCH that fans would actually BUY — not just a copy of the book cover art. What visual style would sell on Etsy for this fandom?`;
  }

  const result = await invokeLLM({
    messages: [
      { role: "system", content: RUN_STYLE_SYSTEM },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
  });

  const content = typeof result.choices[0]?.message?.content === "string"
    ? result.choices[0].message.content
    : "{}";

  const parsed = JSON.parse(content) as StyleProfile;

  // Apply overrides for niche workspaces
  if (opts.workspaceType === "niche_hunter" && opts.override) {
    return { ...parsed, ...opts.override, source: "hybrid" };
  }

  return { ...parsed, source: "computed" };
}
