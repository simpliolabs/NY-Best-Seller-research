/**
 * Pattern Production Processor — v4 (Two-Call Edit→Extract)
 *
 * Two-step pipeline (edit → extract):
 *
 *   Step 1 — REPLACE: FLUX.1 Kontext [max] (via fal) edits the printed graphic on
 *     the FULL uncropped shirt photo IN PLACE. Kontext is an instruction-edit model
 *     that preserves the rest of the image by design — it does not re-render the
 *     whole canvas the way gpt-image-1 did (which redrew figures and invented props
 *     like the salt shaker / fake brand). The edit instruction is built by
 *     planMinimalEdit() + buildEditPrompt(). Output: opaque shirt mockup, niche-swapped.
 *
 *   Step 2 — EXTRACT: gpt-image-1 /edits on the Step 1 output, with background:"transparent".
 *     Prompt explicitly removes the GARMENT (not just the photo background): "Extract
 *     ONLY the printed graphic artwork ... Remove the t-shirt garment entirely ... Do NOT
 *     keep the shirt." (The PO's original "...design on the shirt..." phrasing let the
 *     model keep the tee as the subject for poster-style designs.)
 *     Output: native transparent PNG of the design only.
 *
 *   Step 3 — cropToContent: trim transparent padding.
 *   Step 4 — assertTransparentPng: validate (corner alpha < 16, transparent ≥ 20%,
 *            opaque ≥ 5%). Throws on failure — no silent bad writes.
 *   Step 5 — storagePut → productionDesignUrl (canonical transparent asset).
 *   Step 6 — compositeDesignOnMockup → previewImageUrl (shirt thumbnail).
 *
 * Why this replaces the prior magenta-chromakey approach:
 * The magenta+chromakey path was a workaround for gpt-image-1 background:"transparent"
 * being unreliable when generating from scratch. But the PO's ChatGPT workflow
 * demonstrates that gpt-image-1 background:"transparent" IS reliable when applied to
 * a shirt photo with a clear "remove background, keep design" instruction — the model
 * has concrete pixels to extract from, not a synthesis problem. The magenta path also
 * introduced its own failure mode (model generates a full scene filling the canvas,
 * leaving no magenta to key) which the Dinosaur row exposed.
 *
 * Why gpt-image-1 for the EXTRACT step:
 * gpt-image-2 returns HTTP 400 for background:"transparent" on /v1/images/edits
 * ("Transparent background is not supported for this model"); gpt-image-1 honors it.
 * (Step 1 editing moved to Kontext after a 3-design bake-off showed gpt-image-1
 * re-renders the whole canvas and won't do a faithful in-place edit, whereas
 * Kontext preserved text, figure, AND illustration style.)
 */
import sharp from "sharp";
import { storagePut } from "./storage";
import {
  getProductGroupsByWorkspace,
  getMockupsByGroup,
} from "./productGroupDb";
import {
  compositeDesignOnMockup,
  DEFAULT_PRINT_AREA,
} from "./mockupCompositor";
import { getGarmentBbox, resolveZoneToPhoto } from "./garmentDetector";
import {
  updateTrendPatternImage,
  updateTrendPatternProductionUrl,
  getTrendPatternsByWorkspace,
} from "./nicheHunterDb";
import { invokeLLM } from "./_core/llm";
import type { TrendPattern } from "../drizzle/schema";
import { getWorkspaceById } from "./workspaceDb";

// ─── Shared OpenAI /v1/images/edits caller ───────────────────────────────────

/**
 * Call gpt-image-1 /v1/images/edits with a source image and a prompt.
 * Returns the raw PNG buffer from the API.
 *
 * If `transparent` is true, requests a transparent background (Step 2 extract).
 * Otherwise the model returns an opaque output (Step 1 replace).
 */
async function callImageEdit(
  sourceImg: Buffer,
  filename: string,
  prompt: string,
  options: { transparent: boolean; inputFidelity?: "high" | "low" }
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "high");
  if (options.transparent) {
    formData.append("background", "transparent");
  }
  if (options.inputFidelity) {
    // input_fidelity:"high" tells gpt-image-1 to preserve input features (faces,
    // lettering, layout, art style) during a subtle edit — the API-level lever
    // that stops it redrawing elements it was not asked to touch. Per OpenAI docs
    // this is NOT valid on gpt-image-2; it is honored on gpt-image-1.
    formData.append("input_fidelity", options.inputFidelity);
  }
  const blob = new Blob([new Uint8Array(sourceImg)], { type: "image/png" });
  formData.append("image[]", blob, filename);

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`gpt-image-1 API error (${resp.status}): ${errText.substring(0, 300)}`);
  }

  const data = await resp.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("gpt-image-1 returned no image data");

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dlResp = await fetch(item.url);
    if (!dlResp.ok) throw new Error(`Failed to download generated image: ${dlResp.status}`);
    return Buffer.from(await dlResp.arrayBuffer());
  }
  throw new Error("gpt-image-1 response has neither b64_json nor url");
}

// ─── FLUX.1 Kontext [max] caller (fal queue API) ─────────────────────────────

/**
 * Edit an image with FLUX.1 Kontext [max] via the fal queue API; return the
 * result as a Buffer.
 *
 * Kontext is an instruction-driven image EDITOR: given a source image + a prompt,
 * it changes only what the prompt asks and preserves the rest — the property
 * gpt-image-1 lacked (it re-rendered the whole canvas). Used for Step 1.
 * `imageUrl` is fetched server-side by fal, so no local download is needed.
 *
 * Requires FAL_KEY in the environment (Manus application secret).
 */
async function callFalKontextEdit(imageUrl: string, prompt: string): Promise<Buffer> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not configured");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };

  // Kontext [max] (was [pro]): per fal docs, [max] has "improved prompt adherence
  // and typography integration" — needed because [pro] kept recomposing/adding badges
  // despite repeated minimal-edit guardrail prompts. $0.08/img vs $0.04. Same
  // request/response shape, so this is a one-line endpoint swap.
  const submit = await fetch("https://queue.fal.run/fal-ai/flux-pro/kontext/max", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, image_url: imageUrl }),
  });
  if (!submit.ok) {
    throw new Error(`fal Kontext submit error (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const { status_url, response_url } = (await submit.json()) as {
    status_url: string;
    response_url: string;
  };

  // Poll the queue until COMPLETED (or fail/timeout). ~3s interval, 240s cap.
  let completed = false;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(status_url, { headers })).json()) as {
      status?: string;
      error?: unknown;
    };
    if (st.status === "COMPLETED") { completed = true; break; }
    if (st.status === "FAILED" || st.error) {
      throw new Error(`fal Kontext failed: ${JSON.stringify(st).slice(0, 300)}`);
    }
  }
  if (!completed) throw new Error("fal Kontext timed out after 240s");

  const out = (await (await fetch(response_url, { headers })).json()) as {
    images?: Array<{ url: string }>;
  };
  const url = out.images?.[0]?.url;
  if (!url) throw new Error(`fal Kontext returned no image: ${JSON.stringify(out).slice(0, 200)}`);

  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`Failed to download Kontext output: ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

// ─── Step 0: Vision-grounded minimal-edit planner ────────────────────────────

/**
 * A surgical edit plan derived by LOOKING at the actual source design.
 *
 * This replaces the prose `adaptedConcept` that used to drive Step 1. That field
 * is a from-scratch redesign brief ("a stylized player with a salt shaker…",
 * "…with the text 'Salty Dinker'", "evoking a vintage travel poster") generated
 * from a TEXT description of the source — so it instructed the image model to ADD
 * elements (paddles, wordmarks, props) and REDRAW figures. The result read as a
 * new design, not the original with the niche swapped in.
 *
 * The planner instead enumerates only literal swaps and forbids additions, so
 * "replace, don't redesign" is encoded as data rather than left to chance.
 */
export type EditSpec = {
  /** FIT GATE: can this source genuinely be converted to the niche? If false, skip — don't force it. */
  canConvert: boolean;
  /** Why it does / doesn't fit (shown to the PO when skipped). */
  fitReason: string;
  /** The single best-matching knowledge-base item the adaptation is built around. */
  bestMatch: { type: string; item: string; why: string };
  /**
   * The rich, image-model-ready edit instruction the brain WRITES ITSELF after looking
   * at the source image — the same kind of detailed prompt a human craftsperson writes
   * to ChatGPT. Names the scene elements (shirt + props), specifies the new design
   * vividly (pose, action, details), and style-locks the print medium ("printed INTO
   * the fabric, not pasted on top"). buildEditPrompt only appends AVOID + DTF tail.
   *
   * Replaces the old structured fields (textSwaps/objectSwaps/addText/preserve/etc.) —
   * those required a template that flattened the brain's per-image specificity into
   * generic prose, which Kontext rendered as recompositions. Skipped (empty) when
   * canConvert is false.
   *
   * Legacy fields removed: the per-image vividness lives in this string now.
   */
  editPrompt: string;
};

/**
 * Turn the workspace nicheProfile into a compact "expert knowledge base" the
 * brain LLM reasons over: mascots (on-brand characters), transferable concepts
 * (source-style -> niche adaptation), inside jokes, pain points, rivalries,
 * catchphrases, plus audience / styles / avoid-topics.
 */
function formatNicheKnowledge(profile: any): string {
  if (!profile) return "";
  const cm = (profile.culturalMap ?? {}) as any;
  const L: string[] = [];
  L.push(`NICHE: ${profile.summary || profile.niche || "the niche"}`);
  if (profile.targetAudience) L.push(`AUDIENCE: ${profile.targetAudience}`);
  if (Array.isArray(profile.designStyles) && profile.designStyles.length)
    L.push(`PREFERRED STYLES: ${profile.designStyles.join(", ")}`);
  if (Array.isArray(profile.avoidTopics) && profile.avoidTopics.length)
    L.push(`AVOID TOPICS (never build an adaptation around these): ${profile.avoidTopics.join(", ")}`);
  if (Array.isArray(cm.animalMascots) && cm.animalMascots.length)
    L.push("ON-BRAND MASCOTS (the only on-brand characters; if the design's main subject is an animal/character NOT in this list, it usually does NOT fit):\n" +
      cm.animalMascots.map((m: any) => `  - ${m.animal}: ${m.visualTreatment}`).join("\n"));
  if (Array.isArray(cm.transferableVisualConcepts) && cm.transferableVisualConcepts.length)
    L.push("TRANSFERABLE CONCEPTS (source style -> niche adaptation):\n" +
      cm.transferableVisualConcepts.map((t: any) => `  - ${t.sourcePattern} -> ${t.targetAdaptation}`).join("\n"));
  if (Array.isArray(cm.insideJokes) && cm.insideJokes.length)
    L.push("INSIDE JOKES: " + cm.insideJokes.map((j: any) => j.joke).join(" | "));
  if (Array.isArray(cm.painPoints) && cm.painPoints.length)
    L.push("PAIN POINTS (pain -> humor angle):\n" +
      cm.painPoints.map((p: any) => `  - ${p.pain}: ${p.humorAngle}`).join("\n"));
  if (Array.isArray(cm.rivalries) && cm.rivalries.length)
    L.push("RIVALRIES: " + cm.rivalries.map((r: any) => r.rivalry).join(" | "));
  if (Array.isArray(cm.catchphrases) && cm.catchphrases.length)
    L.push("CATCHPHRASES: " + cm.catchphrases.join(", "));
  return L.join("\n\n");
}

/**
 * NICHE-EXPERT brain (production-path). Primed with the workspace's niche
 * knowledge base, it answers three questions about the source design:
 *   1. canConvert — can this genuinely become a niche design, or is it off-brand?
 *   2. bestMatch — which single knowledge-base item fits THIS design best?
 *   3. plan — the minimal text/object swaps that realise that match.
 * If canConvert is false the caller SKIPS generation (no forced, off-brand art).
 */
async function nicheExpertPlan(
  sourceImageUrl: string,
  nicheProfile: any,
  fallbackNiche: string,
  product: string = "t-shirt"
): Promise<EditSpec> {
  const knowledge = formatNicheKnowledge(nicheProfile);
  const niche =
    (typeof nicheProfile?.summary === "string" && nicheProfile.summary.split(",")[0]) ||
    nicheProfile?.niche ||
    fallbackNiche ||
    "the niche";
  // BRAIN = GPT-5 via OpenAI direct (reverted from Gemini Flash via forge).
  // The PO showed twice that ChatGPT — which uses GPT-5 reasoning + gpt-image-1 internally
  // — produces "same proven design with the subject swapped" from a 12-word intent with
  // ~1 minute of thinking. The Gemini-Flash brain (thinking=128 tokens, ~no reasoning) was
  // architecturally incapable of producing ChatGPT-quality edit prompts. GPT-5 with high
  // reasoning effort matches what ChatGPT does in its silent expansion step.
  // Falls back to gpt-4o if "gpt-5" returns 404 — change BRAIN_MODEL env var to override.
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY is not configured (brain)");
  const brainModel = process.env.BRAIN_MODEL || "gpt-5";
  const openaiBody = {
    model: brainModel,
    // "medium" reasoning (~20-40s) vs "high" (~60-80s) — needed to keep total round-trip
    // under Cloudflare's ~100s edge timeout. Fire-and-forget didn't work on Cloud Run
    // (container scaled down after fast-return killed the background work), so the
    // architecture is back to sync; cutting the brain's reasoning time is the lever.
    reasoning_effort: "medium",
    messages: [
      {
        role: "system",
        content: [
          `You are an expert print-on-demand designer for the "${niche}" niche. A skilled human receives a simple intent and writes a single rich, image-model-ready prompt that produces a faithful edit on the first try. That is your job.`,
          "",
          `You are shown the ACTUAL source ${product} mockup image. Reason through three steps and respond as JSON:`,
          "  1. canConvert — STRICT GATE (read carefully): set TRUE only when BOTH conditions hold:",
          "       (a) The source contains a SPECIFIC concrete element you can name and swap (a character/animal you replace, an object you replace, source text whose niche-specific WORDS you swap in place); AND",
          "       (b) The replacement is a SPECIFIC item from the knowledge base below (a named mascot, a literal catchphrase/inside-joke phrase, a named transferable-concept adaptation).",
          "     Set FALSE when: (i) the source is built on an AVOID TOPIC, OR (ii) the only way to 'convert' would be to INVENT a new subject/scene not present in the source (e.g. replacing the whole composition with a generic landscape, mascot you made up, or copy that isn't in the KB). A clean SKIP is REQUIRED for forced conversions. The previous bad output replaced a Dr-Seuss-style 'One Shirt / Two Shirts' design with an unrelated bear + 'STAY WILD' landscape — that is a manufactured conversion and MUST be canConvert=false.",
          "     Explain in `fitReason` with the specific source element + the specific KB item, OR the specific reason no clean swap exists.",
          "  2. bestMatch — the SINGLE knowledge-base item the adaptation is built on (mascot / inside joke / pain point / rivalry / transferable concept). {type, item, why}. Must literally appear in the KB below.",
          "  3. editPrompt — WRITE the rich Kontext-ready prompt as one flowing paragraph (no headings, no bullets in the output). Empty string when canConvert is false.",
          "",
          "=== NICHE KNOWLEDGE BASE (your ONLY creative palette — every mascot/word/concept you use must literally come from here) ===",
          knowledge || `Niche: ${niche}. (No detailed profile available; use general expert judgement.)`,
          "=== END KNOWLEDGE BASE ===",
          "",
          "HOW TO WRITE `editPrompt` — five parts as one paragraph:",
          "",
          `  A. SCENE LOCK — open by enumerating what is in the source so the model has anchors: "Edit this ${product} mockup directly. Keep the exact flat-lay composition: [the ${product} colour/style + every prop visible + surface/background + lighting/folds + camera angle]." Be specific — not 'preserve composition' but 'the cream tee with rolled sleeves, the wicker placemat, the pale wood floor, the laces at lower right'.`,
          "",
          "  B. THE EDIT — one sentence: \"Only change the printed shirt graphic. Replace [exact thing in source — name it concretely, e.g. 'the two fighting tigers', 'the wordmark SALTY', 'the swords held by the frog'] with [your bestMatch swap], in the same size and centered chest placement.\"",
          "",
          "  C. SOURCE-ANCHORED VIVIDNESS — describe the new subject IN THE SAME STRUCTURE AS THE SOURCE. The new subject inherits the source's POSE, COUNT, ARRANGEMENT, and LAYOUT — only its identity changes. Examples of correct anchoring:",
          "       - Source: two tigers in a circular fighting pose -> 'two raccoons IN THE SAME CIRCULAR FIGHTING POSE, paws locked, mid-pounce, in the source's red line-art style.'  NOT 'two raccoons standing facing each other.'",
          "       - Source: 4 figures stacked vertically with a colour-word each ('One Shirt / Two Shirts / Red Shirt / Blue Shirt') -> '4 figures stacked vertically in the SAME ARRANGEMENT, with the words swapped to a real pickleball catchphrase from the KB — e.g. One Dink / Two Dinks / Red Dink / Blue Dink — each figure holding a paddle.'  NOT 'a bear with mountains.'",
          "     If you cannot describe the new subject by reusing the source's structure, the source does NOT genuinely fit — go back and set canConvert=false.",
          "",
          "  D. STYLE LOCK — describe the source's PRINT MEDIUM so the new graphic matches: \"Keep the print as a [ink count, colour, distress level, line quality, texture], with [softness/weight/edge quality], so it looks printed INTO the fabric rather than pasted on top.\" Examples: 'subtle vintage distressed single-ink in light tan/cream', 'bold gold distressed serif with worn edges', 'flat 2-colour line-art with no shading'. Without this, Kontext defaults to clean illustration.",
          "",
          `  E. PRESERVATION LOCK — close with: "Do not change the ${product} colour, background, props, lighting, camera angle, or anything else in the scene. No new borders, badges, banners, frames, or wordmarks the source did not have."`,
          "",
          "Write all five parts as ONE flowing prompt paragraph. Output strict JSON.",
          "",
          "HARD RULES (the brain's accountability):",
          "1. Every NAMED MASCOT / CATCHPHRASE / CONCEPT in your editPrompt must literally appear in the KNOWLEDGE BASE above. Quote them from there. If you find yourself writing a phrase or subject you cannot point to in the KB, STOP — set canConvert=false instead.",
          "2. Never invent off-brand copy, fake brand names, mock nutrition labels, or generic outdoorsy phrases ('STAY WILD', 'WANDER OFTEN', etc. are NOT pickleball — banned).",
          "3. The new design must REUSE the source's structure (pose, count, arrangement, layout). The identity changes; the structure stays.",
          "4. Always fill `bestMatch` (use {type:'none', item:'-', why:'...'} when canConvert is false). editPrompt must be empty string when canConvert is false.",
          "5. Respect AVOID TOPICS.",
        ].join("\n").replace(/\$\{product\}/g, product),
      },
      {
        role: "user",
        content: [
          {
            type: "image_url" as const,
            image_url: { url: sourceImageUrl, detail: "high" as const },
          },
          {
            type: "text" as const,
            text: `Look at this source ${product} mockup. Decide canConvert + bestMatch, then WRITE the rich editPrompt yourself following the five-part recipe (SCENE LOCK → THE EDIT → NEW-DESIGN VIVIDNESS → STYLE LOCK → PRESERVATION LOCK). Target niche: "${niche}".`,
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "niche_expert_plan",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            canConvert: { type: "boolean" },
            fitReason: { type: "string" },
            bestMatch: {
              type: "object",
              additionalProperties: false,
              properties: { type: { type: "string" }, item: { type: "string" }, why: { type: "string" } },
              required: ["type", "item", "why"],
            },
            editPrompt: { type: "string" },
          },
          required: ["canConvert", "fitReason", "bestMatch", "editPrompt"],
        },
      },
    },
  };
  const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiBody),
  });
  if (!openaiResp.ok) {
    throw new Error(
      `GPT-5 brain API error (${openaiResp.status}): ${(await openaiResp.text()).slice(0, 300)}`
    );
  }
  const response = (await openaiResp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = (response.choices?.[0]?.message?.content ?? "").trim();
  if (!raw) {
    throw new Error("[PatternProd] nicheExpertPlan: empty GPT-5 response");
  }

  let spec: EditSpec;
  try {
    spec = JSON.parse(
      raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "")
    ) as EditSpec;
  } catch {
    throw new Error(
      `[PatternProd] nicheExpertPlan: could not parse plan: ${raw.slice(0, 200)}`
    );
  }
  spec.editPrompt ??= "";
  console.log(
    `[PatternProd] nicheExpertPlan canConvert=${spec.canConvert} ` +
      `match="${spec.bestMatch?.item ?? ""}" editPromptChars=${spec.editPrompt.length} ` +
      `reason="${(spec.fitReason || "").slice(0, 80)}"`
  );
  if (spec.editPrompt) {
    // Log the actual brain-written prompt (preview) so the live output is debuggable —
    // length alone hides whether the brain followed the five-part recipe / stayed on-brand.
    console.log(`[PatternProd] nicheExpertPlan editPrompt PREVIEW: "${spec.editPrompt.slice(0, 600)}${spec.editPrompt.length > 600 ? "…" : ""}"`);
  }
  return spec;
}

/**
 * Append the workspace-level guardrails (AVOID + DTF print constraint) to the rich
 * prompt the brain wrote in `spec.editPrompt`.
 *
 * The brain (nicheExpertPlan) does the heavy lifting: it looks at the source image,
 * consults the knowledge base, and writes the SCENE/EDIT/NEW-DESIGN/STYLE/PRESERVATION
 * recipe directly — the way a human craftsperson writes one rich prompt to ChatGPT.
 * This function just adds the cross-cutting concerns the brain shouldn't know about:
 * the AVOID list (from prior rejections) and the DTF print constraint (printability).
 * No more structured-spec-to-prose templating — that template flattened the per-image
 * specificity which is exactly what Kontext needs to preserve composition.
 */
export function buildEditPrompt(spec: EditSpec, avoid: string[] = [], _product: string = "t-shirt"): string {
  const dtf = "PRINT CONSTRAINT (DTF): the printed graphic must use bold, solid shapes only — no thin hairlines, stipple, halftone, or small scattered dots; any rain/sparkle/texture must be a few BOLD solid strokes or omitted entirely.";
  const avoidLine = avoid.length
    ? `AVOID (these were rejected on previous designs in this shop; do NOT repeat them): ${avoid.join("; ")}.`
    : null;
  return [
    (spec.editPrompt || "").trim(),
    ...(avoidLine ? [avoidLine] : []),
    dtf,
  ].filter(Boolean).join("\n\n");
}

/**
 * Reject-feedback (production-path half of the learning loop).
 *
 * Collect the workspace's previously-rejected reasons + tags (from dismissed
 * patterns) into a concise "AVOID" list injected into the edit prompt, so
 * regenerations stop repeating mistakes the PO has already rejected. Free-text
 * `rejectionReason` is the richest signal (e.g. "salt shaker again"); `rejectionTags`
 * (e.g. too_generic, off_brand) are coarser guidance. Capped to keep the prompt
 * tight. Non-fatal: returns [] on any error.
 *
 * (The scan-time half — biasing fresh concepts — and capturing a reason on the
 * per-render retry live in Manus's files.)
 */
/**
 * Pure aggregation of a workspace's reject signals into a capped AVOID list:
 * free-text rejectionReason first (richest, e.g. "salt shaker again"), then
 * rejectionTags as readable labels; deduped, capped at 8. Exported for unit
 * testing (Karpathy P2: pure, no I/O).
 */
export function aggregateAvoidList(patterns: TrendPattern[]): string[] {
  // Meta-tags that aren't actionable design guidance — drop them from the prompt.
  const NOISE = new Set(["transfer failed", "transfer invalid"]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of patterns) {
    if (p.status !== "dismissed") continue;
    const reason = (p.rejectionReason ?? "").trim();
    if (reason && !seen.has(reason.toLowerCase())) {
      seen.add(reason.toLowerCase());
      out.push(reason);
    }
    for (const tag of ((p.rejectionTags as string[] | null) ?? [])) {
      const label = tag.replace(/_/g, " ").trim();
      if (label && !NOISE.has(label) && !seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
  }
  return out.slice(0, 8);
}

async function getWorkspaceAvoidList(workspaceId: string): Promise<string[]> {
  try {
    const dismissed = await getTrendPatternsByWorkspace(workspaceId, "dismissed");
    const capped = aggregateAvoidList(dismissed);
    if (capped.length) {
      console.log(`[PatternProd] reject-feedback: ${capped.length} AVOID item(s) for workspace ${workspaceId}`);
    }
    return capped;
  } catch (e) {
    console.warn(`[PatternProd] getWorkspaceAvoidList failed (non-fatal):`, e);
    return [];
  }
}

/**
 * The product type for this workspace (e.g. "t-shirt", "mug", "tote bag"), read
 * from the first product group's `productType` config. Keeps the pipeline
 * product-agnostic — the edit/extract prompts are templated on this, so adding a
 * new product is config, not code. Defaults to "t-shirt".
 */
async function getWorkspaceProductType(workspaceId: string): Promise<string> {
  try {
    const groups = await getProductGroupsByWorkspace(workspaceId);
    const first = groups
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    const pt = (first?.productType ?? "").trim();
    return (pt || "T-Shirt").toLowerCase();
  } catch {
    return "t-shirt";
  }
}

// ─── Step 1: Replace design on full shirt photo ──────────────────────────────

/**
 * Edit the source shirt photo with a SURGICAL in-place edit of the existing
 * design — swap only the minimal niche-specific elements (text/subject),
 * preserving the original composition, typography, style, and layout.
 * Output is an opaque shirt mockup — same shirt, same design formula, niche-swapped.
 *
 * Full uncropped photo is fed to the model: the shirt context is what makes
 * gpt-image-1 treat this as a localized edit rather than a from-scratch
 * generation. The prompt explicitly forbids redesign — "replace the entire
 * design" produced fresh designs untrue to the source, which is the bug this fixes.
 */
async function replaceDesignOnShirt(
  sourceImageUrl: string,
  editPrompt: string
): Promise<Buffer> {
  // Step 1 uses gpt-image-1 with input_fidelity:"high" (reverted from FLUX Kontext).
  // The PO showed twice that ChatGPT (which uses gpt-image-1 internally, with GPT-5
  // reasoning writing the prompt) produces the desired "same proven design with the
  // subject swapped" result with a simple intent + ~1 minute of reasoning. Our prior
  // Kontext swap was wrong: Kontext recomposes the source on substantial swaps
  // (architectural failure, paper-confirmed), and the brain it was paired with
  // (Gemini Flash, ~no reasoning) was the wrong brain too. Pairing GPT-5 reasoning
  // brain → rich edit prompt → gpt-image-1 + input_fidelity:high is what ChatGPT does.
  const imgResp = await fetch(sourceImageUrl);
  if (!imgResp.ok) {
    throw new Error(`Failed to download source image: ${imgResp.status}`);
  }
  const sourcePng = await sharp(Buffer.from(await imgResp.arrayBuffer()))
    .png()
    .toBuffer();
  console.log(
    `[PatternProd] Step 1 (gpt-image-1 + input_fidelity:high). Prompt: "${editPrompt.substring(0, 140)}..."`
  );
  return callImageEdit(sourcePng, "source_shirt.png", editPrompt, {
    transparent: false,
    inputFidelity: "high",
  });
}

// ─── Step 2: Extract transparent design from edited shirt photo ──────────────

/**
 * Take the edited shirt photo from Step 1 and extract just the printed design
 * onto a transparent canvas.
 *
 * The prompt must explicitly remove the GARMENT, not just the photo background.
 * The PO's original "...leave only the design on the shirt..." phrasing is
 * ambiguous — "on the shirt" lets the model keep the t-shirt as the subject.
 * That produced a shirt-on-transparent output for framed/poster-style designs
 * (e.g. the Dinosaur row: a cream tee silhouette extracted instead of the print).
 * The validation gate cannot catch this — a garment-on-transparent passes every
 * transparency check. So the disambiguation has to happen in the prompt: name
 * the garment and the fabric parts explicitly and tell the model to drop them.
 *
 * `background: "transparent"` is the API parameter that makes gpt-image-1
 * return a native RGBA PNG with alpha=0 outside the design.
 */
async function extractTransparentFromShirt(shirtMockup: Buffer, product: string = "t-shirt"): Promise<Buffer> {
  // Apparel keeps the proven garment-specific hints (collar/sleeves); other product
  // types (mug, tote, etc.) use a generic "remove all of the product" phrasing.
  const isApparel = /shirt|tee|hoodie|sweat|tank|apparel|garment|jersey|sleeve/i.test(product);
  const removal = isApparel
    ? `Remove the ${product} garment entirely — no fabric, no collar, no sleeves, no seams, no ${product} silhouette.`
    : `Remove the ${product} entirely — every part of the physical ${product} (all material, edges, seams, handles, rims, and silhouette).`;
  const prompt = [
    `Extract ONLY the printed graphic artwork from this ${product} mockup.`,
    removal,
    "Remove all photo background.",
    "Output only the flat 2D printed design itself on a fully transparent background, trimmed tightly to the artwork.",
    `Do NOT keep the ${product}. The ${product} is not part of the design.`,
  ].join(" ");
  console.log(`[PatternProd] Step 2 (extract, product=${product}). Prompt: "${prompt.substring(0, 100)}..."`);
  return callImageEdit(shirtMockup, "shirt_with_design.png", prompt, { transparent: true });
}

// ─── Step 3: Crop to content bounding box ────────────────────────────────────

/**
 * Crop the transparent PNG to the bounding box of non-transparent content.
 * Removes any residual transparent padding around the design.
 */
async function cropToContent(imageBuf: Buffer): Promise<Buffer> {
  try {
    const { data, info } = await sharp(imageBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let minX = width, maxX = 0, minY = height, maxY = 0;
    let found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = data[(y * width + x) * channels + 3];
        if (a > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found) return imageBuf;

    const pad = 4;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cropW = Math.min(width - left, maxX - left + 1 + pad * 2);
    const cropH = Math.min(height - top, maxY - top + 1 + pad * 2);

    const reduction = 1 - (cropW * cropH) / (width * height);
    if (reduction < 0.05) return imageBuf;

    return sharp(imageBuf)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  } catch {
    return imageBuf;
  }
}

// ─── Step 3.5: DTF despeckle (remove un-printable isolated specks) ────────────

/**
 * DTF safety net: zero the alpha of free-floating ink islands smaller than
 * `minArea` pixels. DTF transfer cannot reproduce sub-millimetre isolated marks
 * (stray specks, scattered dots) — they under-powder and peel off the film.
 *
 * This removes ISOLATED small components only. Texture that is connected to a
 * larger shape (e.g. distress holes inside solid lettering) is untouched — those
 * are gaps within one big component, not separate islands. Thin connected LINES
 * (e.g. rain) are deliberately NOT handled here: width-based erosion that removes
 * them also damages wanted thin elements like small text, so rain is constrained
 * at generation (see the DTF line in buildEditPrompt) instead.
 *
 * 4-connectivity flood-fill labelling; O(pixels). Returns the input unchanged if
 * nothing is removed.
 */
async function despeckleForDtf(buf: Buffer, minArea = 24): Promise<Buffer> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const total = w * h;
  const ON = 128;
  const comp = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(total);
  let cur = 0;
  for (let p = 0; p < total; p++) {
    if (comp[p] !== -1) continue;
    if (data[p * ch + 3] < ON) { comp[p] = -2; continue; }
    let sp = 0; stack[sp++] = p; comp[p] = cur; let cnt = 0;
    while (sp > 0) {
      const q = stack[--sp]; cnt++;
      const x = q % w, y = (q / w) | 0;
      if (x > 0 && comp[q - 1] === -1 && data[(q - 1) * ch + 3] >= ON) { comp[q - 1] = cur; stack[sp++] = q - 1; }
      if (x < w - 1 && comp[q + 1] === -1 && data[(q + 1) * ch + 3] >= ON) { comp[q + 1] = cur; stack[sp++] = q + 1; }
      if (y > 0 && comp[q - w] === -1 && data[(q - w) * ch + 3] >= ON) { comp[q - w] = cur; stack[sp++] = q - w; }
      if (y < h - 1 && comp[q + w] === -1 && data[(q + w) * ch + 3] >= ON) { comp[q + w] = cur; stack[sp++] = q + w; }
    }
    sizes.push(cnt); cur++;
  }
  let removed = 0;
  for (let p = 0; p < total; p++) {
    const c = comp[p];
    if (c >= 0 && sizes[c] < minArea) { data[p * ch + 3] = 0; removed++; }
  }
  if (removed === 0) return buf;
  console.log(`[PatternProd] despeckleForDtf: removed ${removed}px across islands <${minArea}px`);
  return sharp(data, { raw: { width: w, height: h, channels: ch } }).png().toBuffer();
}

// ─── Step 4: Output validation ───────────────────────────────────────────────

/**
 * Assert that a PNG buffer has a transparent background AND actual design content.
 *
 * Three checks must all pass:
 *   1. Corner pixels: all 4 corners must have alpha < 16 (nearly transparent)
 *   2. Transparent pixel ratio: ≥ 20% of pixels must have alpha < 128
 *   3. Non-transparent pixel ratio: ≥ 5% must be opaque (catches blank-canvas outputs)
 *
 * If any check fails, throws an error with the patternId for log tracing.
 * This is the final safety net — no silent bad writes to productionDesignUrl.
 */
export async function assertTransparentPng(buf: Buffer, patternId: string): Promise<void> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Check 1: 4 corner pixels must all have alpha < 16
  const cornerCoords = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ] as const;

  for (const [cx, cy] of cornerCoords) {
    const alpha = data[(cy * width + cx) * channels + 3];
    if (alpha >= 16) {
      throw new Error(
        `[PatternProd] VALIDATION FAIL pattern=${patternId}: corner pixel (${cx},${cy}) has alpha=${alpha} (expected <16). Extract step did not produce transparent background. Aborting storagePut.`
      );
    }
  }

  // Check 2: transparent pixel ratio must be ≥ 20%
  let transparentCount = 0;
  const totalPixels = width * height;
  for (let i = 0; i < totalPixels; i++) {
    if (data[i * channels + 3] < 128) transparentCount++;
  }
  const ratio = transparentCount / totalPixels;
  if (ratio < 0.20) {
    throw new Error(
      `[PatternProd] VALIDATION FAIL pattern=${patternId}: transparent pixel ratio=${(ratio * 100).toFixed(1)}% (expected ≥20%). Extract step did not remove enough background. Aborting storagePut.`
    );
  }

  // Check 3: design must have content — non-transparent pixels must be ≥ 5% of total
  // Catches blank or near-blank outputs (model returned empty canvas after extract).
  const opaqueCount = totalPixels - transparentCount;
  const opaqueRatio = opaqueCount / totalPixels;
  if (opaqueRatio < 0.05) {
    throw new Error(
      `[PatternProd] DESIGN_TOO_SPARSE pattern=${patternId}: non-transparent pixel ratio=${(opaqueRatio * 100).toFixed(1)}% (expected ≥5%). Design is blank or near-blank. Aborting storagePut.`
    );
  }

  console.log(`[PatternProd] assertTransparentPng PASS pattern=${patternId}: ratio=${(ratio * 100).toFixed(1)}% transparent, ${(opaqueRatio * 100).toFixed(1)}% design content`);
}

// ─── Default template selection ──────────────────────────────────────────────

/**
 * Get the first mockup template for a workspace (by createdAt ASC, then sortOrder ASC).
 * Returns null if no product group or templates exist for the workspace.
 */
async function getFirstWorkspaceTemplate(workspaceId: string) {
  const groups = await getProductGroupsByWorkspace(workspaceId);
  if (groups.length === 0) return null;

  const firstGroup = groups.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )[0];

  const templates = await getMockupsByGroup(firstGroup.id);
  if (templates.length === 0) return null;

  return { template: templates[0], group: firstGroup };
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Full production pipeline for a single trend pattern.
 *
 * Pipeline:
 *   1. Step 1 — replaceDesignOnShirt (gpt-image-1 /edits on full shirt photo)
 *   2. Step 2 — extractTransparentFromShirt (gpt-image-1 /edits + transparent BG)
 *   3. Step 3 — cropToContent (trim transparent padding)
 *   4. Step 4 — assertTransparentPng (validate or throw)
 *   5. Step 5 — storagePut + updateTrendPatternProductionUrl
 *   6. Step 6 — compositeDesignOnMockup → previewImageUrl
 *
 * Writes both productionDesignUrl and previewImageUrl to DB on success.
 * Throws if the validation gate rejects the extract output — no silent bad writes.
 */
export async function processPatternProduction(
  patternId: string,
  workspaceId: string,
  sourceImageUrl: string,
  promptDescription: string
): Promise<{ productionDesignUrl: string; previewImageUrl: string }> {
  console.log(`[PatternProd] Processing pattern ${patternId}...`);

  // Step 0: NICHE-EXPERT evaluation — primed with the workspace's niche knowledge
  // base, it decides (1) can this be converted at all, (2) which knowledge-base
  // item fits this design best, (3) the minimal swaps. If it does NOT fit, SKIP:
  // leave the old image and report the reason (no forced, off-brand art).
  const ws = await getWorkspaceById(workspaceId);
  const product = await getWorkspaceProductType(workspaceId); // agentic: "t-shirt", "mug", etc.
  const editSpec = await nicheExpertPlan(sourceImageUrl, ws?.nicheProfile ?? null, promptDescription, product);
  if (!editSpec.canConvert) {
    throw new Error(
      `NICHE_FIT_SKIP pattern=${patternId}: ${editSpec.fitReason || "source does not fit the niche"}`
    );
  }
  // Reject-feedback: inject the workspace's previously-rejected reasons so the
  // regeneration avoids repeating mistakes the PO already dismissed.
  const avoid = await getWorkspaceAvoidList(workspaceId);
  const editPrompt = buildEditPrompt(editSpec, avoid, product);

  // Step 1: Surgically edit the source product photo using only the planned swaps.
  const shirtMockup = await replaceDesignOnShirt(sourceImageUrl, editPrompt);

  // Step 2: Extract just the design onto a transparent canvas
  const rawTransparent = await extractTransparentFromShirt(shirtMockup, product);

  // Step 3a: DTF despeckle — drop un-printable isolated specks before cropping
  // (so a stray dot in a corner doesn't inflate the crop bbox).
  const despeckled = await despeckleForDtf(rawTransparent);

  // Step 3b: Crop to content bounding box
  const transparentPng = await cropToContent(despeckled);

  // Step 4: Validate transparency + content presence (throws on failure)
  await assertTransparentPng(transparentPng, patternId);

  // Step 5: Upload transparent PNG as productionDesignUrl
  const prodKey = `pattern-production/${patternId}-${Date.now()}.png`;
  const { url: productionDesignUrl } = await storagePut(prodKey, transparentPng, "image/png");
  await updateTrendPatternProductionUrl(patternId, productionDesignUrl);
  console.log(`[PatternProd] productionDesignUrl: ${productionDesignUrl}`);

  // Step 6: Composite onto first workspace template for previewImageUrl
  let previewImageUrl: string;
  try {
    const result = await getFirstWorkspaceTemplate(workspaceId);
    if (result) {
      const { template, group } = result;
      const printAreaRelGarment = (group.printZone as { x: number; y: number; width: number; height: number } | null) ?? DEFAULT_PRINT_AREA;
      const garmentBbox = await getGarmentBbox(template.id, template.imageUrl);
      const printZone = resolveZoneToPhoto(printAreaRelGarment, garmentBbox);

      const compositeBuffer = await compositeDesignOnMockup({
        designUrl: productionDesignUrl,
        mockupUrl: template.imageUrl,
        printZone,
      });

      const previewKey = `pattern-preview/${patternId}-${Date.now()}.webp`;
      const { url } = await storagePut(previewKey, compositeBuffer, "image/webp");
      previewImageUrl = url;
      console.log(`[PatternProd] previewImageUrl (composite): ${previewImageUrl}`);
    } else {
      previewImageUrl = productionDesignUrl;
      console.log(`[PatternProd] No template found for workspace ${workspaceId}, using transparent PNG as preview`);
    }
  } catch (err) {
    console.warn(`[PatternProd] Composite failed, falling back to transparent PNG:`, err);
    previewImageUrl = productionDesignUrl;
  }

  // Step 7: Update previewImageUrl in DB
  await updateTrendPatternImage(patternId, previewImageUrl);
  console.log(`[PatternProd] Pattern ${patternId} done.`);

  return { productionDesignUrl, previewImageUrl };
}
