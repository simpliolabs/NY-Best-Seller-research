/**
 * Onboarding tRPC router — Phase B + Style-Faithful Pipeline (Deep Cultural Map)
 *
 * Two procedures only (Karpathy P2: minimum code):
 *   1. enrichNiche  — takes a plain-language niche description, returns structured profile via LLM
 *   2. finalizeWorkspace — creates the workspace row with the confirmed niche profile
 *
 * No draft persistence. No streaming. No multi-step server state.
 * The wizard state lives entirely in the React component.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import { createWorkspace } from "./workspaceDb";

// ─── Niche Profile Shape ────────────────────────────────────────────────────
// Deep Cultural Map sub-schemas
const animalMascotSchema = z.object({
  animal: z.string(),
  whyItWorks: z.string(),
  visualTreatment: z.string(),
});

const painPointSchema = z.object({
  pain: z.string(),
  humorAngle: z.string(),
});

const funPointSchema = z.object({
  joy: z.string(),
  visualConcept: z.string(),
});

const insideJokeSchema = z.object({
  joke: z.string(),
  context: z.string(),
});

const physicalComedySchema = z.object({
  scenario: z.string(),
  whyFunny: z.string(),
});

const lifestyleIdentitySchema = z.object({
  trait: z.string(),
  purchaseDriver: z.string(),
});

const rivalrySchema = z.object({
  rivalry: z.string(),
  tension: z.string(),
  humorAngle: z.string(),
});

const transferableVisualConceptSchema = z.object({
  sourceNiche: z.string(),
  sourcePattern: z.string(),
  targetAdaptation: z.string(),
  whyItTransfers: z.string(),
});

const culturalMapSchema = z.object({
  animalMascots: z.array(animalMascotSchema),
  painPoints: z.array(painPointSchema),
  funPoints: z.array(funPointSchema),
  insideJokes: z.array(insideJokeSchema),
  physicalComedy: z.array(physicalComedySchema),
  catchphrases: z.array(z.string()),
  lifestyleIdentity: z.array(lifestyleIdentitySchema),
  rivalries: z.array(rivalrySchema),
  transferableVisualConcepts: z.array(transferableVisualConceptSchema),
});

export const nicheProfileSchema = z.object({
  summary: z.string(),
  targetAudience: z.string(),
  subreddits: z.array(z.string()),
  etsyKeywords: z.array(z.string()),
  crossNicheCategories: z.array(z.string()),
  /** General best-seller search terms for the product type (e.g. "funny shirt", "graphic tee") */
  generalBestSellerTerms: z.array(z.string()).optional(),
  designStyles: z.array(z.string()),
  avoidTopics: z.array(z.string()),
  culturalMap: culturalMapSchema,
  // Keep for backward compat — ignored in new code
  culturalMoments: z.array(z.string()).optional(),
});

export type NicheProfile = z.infer<typeof nicheProfileSchema>;
export type CulturalMap = z.infer<typeof culturalMapSchema>;

// ─── Router ─────────────────────────────────────────────────────────────────
export const onboardingRouter = router({
  /**
   * Step 3 of wizard: user submits plain-language niche description,
   * LLM returns a structured NicheProfile with deep cultural map for review.
   */
  enrichNiche: protectedProcedure
    .input(
      z.object({
        description: z.string().min(10).max(1000),
        workspaceName: z.string().min(1).max(100),
      })
    )
    .mutation(async ({ input }) => {
      const response = await invokeLLM({
        model: "gemini-2.5-pro",
        messages: [
          {
            role: "system",
            content: `You are a print-on-demand niche research expert specializing in funny/clever t-shirt design for specific communities.

Given a niche description, produce a structured JSON profile that will guide automated market research scanning.

CRITICAL RULES:

1. SUBREDDITS: Only include subreddits DIRECTLY about this niche. No generic sports/hobby subreddits. Include regional communities when they exist.

2. ETSY IN-NICHE KEYWORDS: Search terms buyers type on Etsy for THIS specific niche. Be very specific. Include variations: funny, gift, dad/mom, specific inside jokes.

3. CROSS-NICHE CATEGORIES: BROAD CATEGORY SEARCH TERMS for Etsy to browse hot sellers in COMPLETELY DIFFERENT niches. These are used as-is as Etsy search queries — they must be natural, broad search terms a real buyer would type.
   CORRECT: "hiking shirts", "yoga shirts", "fishing shirts", "bowling shirts", "camping shirts", "golf shirts", "hunting shirts", "dog mom shirts", "cat shirts", "nurse shirts", "teacher shirts"
   WRONG: "gorilla hiking shirt graphic", "cat yoga tee graphic", "funny dog hiking shirt", "retro alien bowling shirt" — too specific, too narrow, adds junk words
   RULE: 1-3 words max. Must be a real category a buyer searches. Never add "graphic", "funny", or animal names unless the animal IS the category (e.g. "cat shirts" is fine).
   Give 6-8 categories. NEVER include the target niche itself.

3b. GENERAL BEST-SELLER TERMS: Broad Etsy search terms for the GENERAL MARKET of the product type being sold. These are NOT niche-specific — they represent what's hot across ALL funny/graphic apparel.
   For graphic tees: ["funny shirt", "graphic tee", "graphic shirt"]
   For hoodies: ["funny hoodie", "graphic hoodie"]
   For mugs: ["funny mug", "graphic mug"]
   Give 2-3 terms matching the product type. These will be scraped as best-sellers alongside cross-niche categories.

4. DESIGN STYLES: Visual styles that resonate with this audience (e.g. "vintage distressed", "minimalist line art").

5. AVOID TOPICS: Competitor niches, generic slogans, oversaturated angles.

6. CULTURAL MAP — This is the most important section. Go deep. Think like an insider:
   - animalMascots: Animals/characters that WORK for this niche. THINK BROADLY — consider:
     * Physical comedy fit: Does the animal's body shape, size, or quirk map to something funny in this sport/activity? (e.g., T-Rex = short arms can't reach; Llama = long neck for reaching high shots, spits when frustrated; Sloth = slow reaction time)
     * Personality fit: Does the animal's personality stereotype match the community vibe? (e.g., Badger = tenacious, never gives up)
     * Cultural icon fit: Is this animal already beloved/meme-worthy in pop culture in a way that transfers?
     * Underdog/lovable fit: Quirky animals that fans would wear proudly (llama, capybara, axolotl, etc.)
     MANDATORY: Include at least one obvious sport-specific physical comedy animal AND one quirky/lovable animal. Give 5-7 animals minimum.
   - painPoints: Real frustrations this community has, with a humor angle for t-shirts. Give 4-6 pain points.
   - funPoints: Joyful moments unique to this niche with a visual concept. Give 3-5 fun points.
   - insideJokes: Actual jokes/memes the community uses, with context. Give 4-8 jokes.
   - physicalComedy: Funny physical scenarios specific to this activity. Give 3-5 scenarios.
   - catchphrases: Real phrases this community says. Give 6-10 catchphrases.
   - lifestyleIdentity: Who these people are and why they buy apparel. Give 3-5 identity traits.
   - rivalries: Tensions with other groups/activities that drive humor. Give 2-4 rivalries.
   - transferableVisualConcepts: Specific cross-niche visual formulas that could work. For each, name the source niche, the source pattern, how it adapts, and why it transfers. Give 4-6 concepts.

Return ONLY valid JSON matching the exact schema.`,
          },
          {
            role: "user",
            content: `Workspace name: "${input.workspaceName}"\nNiche description: "${input.description}"\n\nGenerate the full niche profile JSON with deep cultural map.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "niche_profile",
            strict: true,
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                targetAudience: { type: "string" },
                subreddits: { type: "array", items: { type: "string" } },
                etsyKeywords: { type: "array", items: { type: "string" } },
                crossNicheCategories: { type: "array", items: { type: "string" } },
                generalBestSellerTerms: { type: "array", items: { type: "string" } },
                designStyles: { type: "array", items: { type: "string" } },
                avoidTopics: { type: "array", items: { type: "string" } },
                culturalMoments: { type: "array", items: { type: "string" } },
                culturalMap: {
                  type: "object",
                  properties: {
                    animalMascots: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          animal: { type: "string" },
                          whyItWorks: { type: "string" },
                          visualTreatment: { type: "string" },
                        },
                        required: ["animal", "whyItWorks", "visualTreatment"],
                        additionalProperties: false,
                      },
                    },
                    painPoints: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          pain: { type: "string" },
                          humorAngle: { type: "string" },
                        },
                        required: ["pain", "humorAngle"],
                        additionalProperties: false,
                      },
                    },
                    funPoints: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          joy: { type: "string" },
                          visualConcept: { type: "string" },
                        },
                        required: ["joy", "visualConcept"],
                        additionalProperties: false,
                      },
                    },
                    insideJokes: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          joke: { type: "string" },
                          context: { type: "string" },
                        },
                        required: ["joke", "context"],
                        additionalProperties: false,
                      },
                    },
                    physicalComedy: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          scenario: { type: "string" },
                          whyFunny: { type: "string" },
                        },
                        required: ["scenario", "whyFunny"],
                        additionalProperties: false,
                      },
                    },
                    catchphrases: { type: "array", items: { type: "string" } },
                    lifestyleIdentity: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          trait: { type: "string" },
                          purchaseDriver: { type: "string" },
                        },
                        required: ["trait", "purchaseDriver"],
                        additionalProperties: false,
                      },
                    },
                    rivalries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          rivalry: { type: "string" },
                          tension: { type: "string" },
                          humorAngle: { type: "string" },
                        },
                        required: ["rivalry", "tension", "humorAngle"],
                        additionalProperties: false,
                      },
                    },
                    transferableVisualConcepts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sourceNiche: { type: "string" },
                          sourcePattern: { type: "string" },
                          targetAdaptation: { type: "string" },
                          whyItTransfers: { type: "string" },
                        },
                        required: ["sourceNiche", "sourcePattern", "targetAdaptation", "whyItTransfers"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: [
                    "animalMascots", "painPoints", "funPoints", "insideJokes",
                    "physicalComedy", "catchphrases", "lifestyleIdentity",
                    "rivalries", "transferableVisualConcepts",
                  ],
                  additionalProperties: false,
                },
              },
              required: [
                "summary", "targetAudience", "subreddits", "etsyKeywords",
                "crossNicheCategories", "generalBestSellerTerms", "designStyles",
                "avoidTopics", "culturalMoments", "culturalMap",
              ],
              additionalProperties: false,
            },
          },
        },
      });

      const rawContent = response.choices?.[0]?.message?.content;
      const content = typeof rawContent === "string" ? rawContent : null;
      if (!content) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "LLM returned empty response" });
      }

      let parsed: NicheProfile;
      try {
        parsed = nicheProfileSchema.parse(JSON.parse(content));
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "LLM returned invalid profile structure",
        });
      }

      return parsed;
    }),

  /**
   * Step 4 of wizard: user confirms (optionally edits) the profile,
   * then submits to create the workspace.
   */
  finalizeWorkspace: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
        icon: z.string().max(10).default("🎯"),
        nicheProfile: nicheProfileSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = await createWorkspace({
        name: input.name,
        slug: input.slug,
        icon: input.icon,
        workspaceType: "niche_hunter",
        ownerId: ctx.user.openId,
        nicheProfile: input.nicheProfile as Record<string, unknown>,
      });

      // Fire-and-forget: compute base style profile from niche profile
      void (async () => {
        try {
          const { computeBaseStyleProfile } = await import("./styleIntelligence");
          const { updateWorkspace } = await import("./workspaceDb");
          const profile = await computeBaseStyleProfile(input.nicheProfile as Record<string, unknown>);
          await updateWorkspace(workspace.id, { styleProfile: profile });
          console.log(`[Onboarding] Base style profile computed for workspace ${workspace.id}`);
        } catch (err) {
          console.warn(`[Onboarding] Base style computation failed (non-fatal):`, err);
        }
      })();

      return workspace;
    }),
});
