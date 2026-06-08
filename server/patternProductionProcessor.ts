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
  updateTrendPatternConcept,
  updateTrendPatternPreviewUrls,
  updateTrendPatternProductionUrl,
  updateTrendPatternStatus,
  updateTrendPatternValidationReport,
  recordRejectionSignal,
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
  options: { transparent: boolean; inputFidelity?: "high" | "low"; quality?: "high" | "medium" | "low" }
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  // quality: "high" is the slowest tier (~90–180s per call) and is the dominant cost
  // per pattern. Callers can downgrade an intermediate stage to "medium" (~30–60s)
  // when its output isn't the final asset — Step 1 (replaceDesignOnShirt) does this
  // because Step 2 extracts from it and re-rasters at high; Step 2 keeps default high.
  formData.append("quality", options.quality ?? "high");
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
  /**
   * One-line, plain-English description of the NEW design this plan produces — written
   * for the human, not the image model. e.g. "Three capybaras playing pickleball around
   * a glowing pickleball moon, painterly vintage style." Saved back to the pattern's
   * adaptedConcept after production so the CARD matches the actual IMAGE. Without this,
   * the card showed the scan-time brain's guess (e.g. "T-Rex/Llama/Octopus") while the
   * image showed something else — the two-brain disconnect. Empty when canConvert=false.
   */
  conceptSummary: string;
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
  product: string = "t-shirt",
  avoid: string[] = [],
  chosenConcept: string = ""
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
          ...(chosenConcept ? [
            `THE CONCEPT IS ALREADY CHOSEN by the PO: "${chosenConcept}". Do NOT pick a different one. Set canConvert=true and write the editPrompt + conceptSummary to realize THIS concept faithfully on the source; set bestMatch to the KB item it is built on. (Only set canConvert=false if the source genuinely cannot render this concept at all.)`,
            "",
          ] : []),
          `You are shown the ACTUAL source ${product} mockup image. Reason through three steps and respond as JSON:`,
          "  1. canConvert — THE EASE GATE. First ask yourself, like a human designer would: \"Will this specific design be EASY and CLEAN for me to convert to " + niche + "?\" Most designs are NOT — and skipping them is the CORRECT, expected answer. Be picky. Set TRUE only when there is an OBVIOUS, MINIMAL, CLEAN conversion:",
          "       (a) a number/score swap (e.g. '567.9' → '0-0-2'), OR",
          "       (b) a word/pun swap that preserves the source's wordplay (e.g. VELOCIREADER → VELOCIDINKER), OR",
          "       (c) a 1:1 subject swap where an off-brand ANIMAL/CHARACTER becomes a named KB mascot in the SAME pose/structure, OR",
          "       (d) a 1:1 object swap (e.g. the moon → a pickleball).",
          "     In every case the source must already supply the STRUCTURE; you only swap the minimal niche-relevant element. If you can name the exact small swap in one sentence, it's EASY → TRUE.",
          "     ★ THE MOST COMMON & BEST easy win is (c) the MASCOT SWAP: any funny graphic tee whose subject is an ANIMAL/CHARACTER (e.g. a cowboy frog, a raccoon, a duck) converts cleanly by swapping that animal for a KB mascot (llama, etc.) in the EXACT same pose, outfit, props, and text. This QUALIFIES even if NO pickleball equipment is added — the on-brand mascot IS the conversion (a cowboy llama saying 'Well Sheeyit' is a valid on-brand design; you need not bolt on a paddle). Keep the source's hat/bandana/pose/wording; change ONLY the animal. 'Funny graphic shirt' bestsellers are FULL of these — say TRUE generously for clean animal-swaps. Do NOT skip a clean mascot-swap for 'not pickleball enough'.",
          "     Set FALSE (SKIP — this is common and correct) when ANY of these hold:",
          "       - the source is built on an AVOID TOPIC;",
          "       - converting would require INVENTING a scene/subject/copy not in the source;",
          "       - DECORATIVE-MOTIF + LIFESTYLE-TEXT: the source is a decorative illustration (dandelion, florals, feathers, butterflies, mountains, sunset, waves, trees) carrying an inspirational/lifestyle phrase. Swapping the phrase to a niche pun leaves niche WORDS on UNRELATED ART = incoherent (e.g. a dandelion 'just breathe' → 'Find Your Dink Center' is a FAIL — the dandelion has no niche hook). A text/word swap is clean ONLY when the design is TEXT-DRIVEN (typography on a plain background) OR the imagery itself is niche-convertible. PO-flagged.",
          "       - the only way to 'convert' is to OVERLAY a generic niche theme onto an unrelated source. BANNED PATTERN (PO-flagged, happening repeatedly): forcing a camping / national-park / outdoors / 'protect our parks' / mountain-scene source into 'DINK VALLEY NATIONAL PARK' (or any 'Dink Valley'/'Pickleball [Place]' / 'pickleball icons grid' theme). A camping or national-park design has NO genuine pickleball hook — there is no clean minimal swap — so it MUST be canConvert=false. Do NOT keep manufacturing 'Dink Valley'. If you catch yourself reaching for a place-name pun or a generic pickleball-icon overlay to make an outdoorsy source 'work', STOP and set FALSE.",
          "       - the conversion would be forced, awkward, or a stretch in ANY way. When unsure, SKIP.",
          "     Explain in `fitReason`: if TRUE, name the exact one-sentence swap; if FALSE, name why there is no clean/easy conversion.",
          "  2. bestMatch — the SINGLE knowledge-base item the adaptation is built on (mascot / inside joke / pain point / rivalry / transferable concept). {type, item, why}. Must literally appear in the KB below.",
          "  3. editPrompt — WRITE the rich Kontext-ready prompt as one flowing paragraph (no headings, no bullets in the output). Empty string when canConvert is false.",
          "",
          "=== NICHE KNOWLEDGE BASE (your ONLY creative palette — every mascot/word/concept you use must literally come from here) ===",
          knowledge || `Niche: ${niche}. (No detailed profile available; use general expert judgement.)`,
          "=== END KNOWLEDGE BASE ===",
          "",
          ...(avoid.length ? [
            "=== LEARN FROM THE PO'S REJECTIONS (craft lessons — take them seriously) ===",
            "The PO dismissed previous designs for these reasons. These are mostly about BAD",
            "TRANSFERS — the adaptation itself was wrong, not a disliked word. Read each as a",
            "craft lesson and diagnose WHAT made that transfer bad:",
            ...avoid.map((a, i) => `  ${i + 1}. ${a}`),
            "Apply the lessons to THIS design:",
            "  - A bad transfer is usually: inaccurate niche equipment/detail (e.g. round ping-pong paddle instead of a rectangular pickleball paddle), source props left un-converted (a camper/tent/fishing rod still in a 'pickleball' design), a forced or shallow pun that keeps the source's theme instead of re-theming to the niche, or a concept that doesn't genuinely fit the niche. Make sure THIS transfer commits none of the named failures.",
            "  - A GOOD transfer fully RE-THEMES the source into the niche (not a surface word-swap over the original theme) and renders accurate niche detail.",
            "  - Choose the concept that genuinely best fits THIS specific source — don't default to the safest/most-obvious one.",
            "=== END REJECTIONS ===",
            "",
          ] : []),
          "HOW TO WRITE `editPrompt` — five parts as one paragraph:",
          "",
          "  ★ MINIMAL-EDIT-FIRST (the most important rule, decide this BEFORE writing the parts):",
          "    Make the SMALLEST change that makes the design read as " + niche + ". Ask: 'can a single",
          "    number/word swap do it?' If the source already has on-theme art and only its TEXT needs to",
          `    change (e.g. a score "567.9" → the real pickleball score "0-0-2"; a word → a ${niche} word),`,
          "    the editPrompt must instruct ONLY that swap and explicitly say: 'Change NOTHING else — keep the",
          "    existing artwork, characters, numbers, layout, fonts, and style EXACTLY as they are, pixel-for-pixel.'",
          "    Do NOT redraw, re-pose, restyle, or re-letter anything that can stay. ONLY redraw a subject when",
          "    the niche genuinely requires it (an off-brand animal/character that must become an on-brand mascot,",
          "    or source text that is not niche-relevant). A minimal faithful swap always beats a fuller redesign.",
          "    (PO-flagged failure: a '567.9 dinosaurs' tee with a T-Rex skeleton should have become '0-0-2 dinosaurs'",
          "    with the SAME skeleton — instead the brain redrew the T-Rex, rewrote the tagline, and added a random",
          "    wine glass. That is exactly the over-editing to avoid.)",
          "",
          "  ★ SOURCE WORDPLAY → NICHE WORDPLAY (clever puns are the IDEAL transfer):",
          "    If the source's text is a PUN or PORTMANTEAU, produce the niche version that PRESERVES THE SAME",
          "    WORD STRUCTURE — keep the same character and pose, and swap only the related prop.",
          `    Worked example: "VELOCIREADER" (velociraptor + reader, raptor holding a book) → "VELOCIDINKER"`,
          "    (velociraptor + dinker), SAME raptor in the SAME pose, book swapped for a pickleball paddle. That",
          "    elegant structure-preserving pun is FAR better than a generic phrase like 'Big Dink Energy'. Coin",
          "    the niche pun from a real KB root (dink → dinker) — see HARD RULE 1's carve-out. Always prefer the",
          "    clever minimal pun over a from-scratch redesign.",
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
          "  D. STYLE LOCK — describe the source's PRINT MEDIUM and EXPLICITLY DEMAND its preservation. gpt-image-1 defaults to clean vector flatness when it changes the subject — if you don't name the texture/distress/grain explicitly and forbid simplification, you lose the source's vintage screen-print feel and end up with generic shapes (PO-confirmed regression: a forest-tee with hand-drawn distressed pines + copper sun came out as flat black paddles + flat yellow ball — no texture, no distress, no inheritance of the print medium). Template: \"Keep the print as a [ink count, ink colour, distress level, line quality, grain/texture], with [softness/weight/edge quality] — DO NOT simplify, smooth, or vectorize the distress; reproduce the same uneven ink coverage, chipped edges, and grainy specks. The output must look printed INTO the fabric, not pasted on top.\" Examples: 'subtle vintage distressed single-ink in cream, preserve the worn fade and uneven coverage', 'bold mustard distressed serif with chipped edges, keep the broken texture on every letter', 'flat 2-colour line-art with grainy screen-print specks intact, not clean vectors'. If the source has obvious distress, naming it is NON-NEGOTIABLE.",
          "",
          `  E. PRESERVATION LOCK — close with: "Do not change the ${product} colour, background, props, lighting, camera angle, or anything else in the scene. Add NOTHING that is not in the source — no new objects, drinks, wine glasses, extra balls or paddles, badges, banners, frames, stars, or decorations. The ONLY new element allowed is the direct replacement of a named source element (e.g. moon→pickleball). Everything not explicitly swapped stays exactly as it was."`,
          "",
          "Write all five parts as ONE flowing prompt paragraph. Output strict JSON.",
          "",
          "HARD RULES (the brain's accountability):",
          "1. Every NAMED MASCOT / CONCEPT must come from the KNOWLEDGE BASE above. For CATCHPHRASES, quote the KB — EXCEPT you MAY COIN a short pickleball pun/portmanteau built from a real KB root word (e.g. 'dink' → 'dinker' → 'VELOCIDINKER', 'kitchen' → wordplay) WHEN it preserves a pun in the source text. A coined pun must be unmistakably pickleball and clearly derived from a KB term. If you'd write a phrase that is neither in the KB nor a clear pickleball pun from a KB root, STOP — set canConvert=false instead.",
          "2. Never invent off-brand copy, fake brand names, mock nutrition labels, or generic outdoorsy phrases ('STAY WILD', 'WANDER OFTEN', etc. are NOT pickleball — banned).",
          "3. The new design must REUSE the source's structure (pose, count, arrangement, layout). The identity changes; the structure stays.",
          "4. Always fill `bestMatch` (use {type:'none', item:'-', why:'...'} when canConvert is false). editPrompt must be empty string when canConvert is false.",
          "5. Respect AVOID TOPICS.",
          "6. KEEP THE SOURCE'S ORIGINAL COLOURS AND PALETTE. Do NOT recolour the design to suit shirt colours. The proven-bestseller transfers preserve the source's exact palette — a dark mystical glow stays a dark mystical glow, an earthy muted cartoon stays earthy and muted. The ONLY change is the subject identity (and any swapped text); the colour scheme, ink treatment, and overall mood are inherited verbatim from the source. (Shirt-colour suitability is handled later by choosing WHICH shirt colours to offer per design — never by altering the design's palette.)",
          `7. PICKLEBALL EQUIPMENT MUST BE ACCURATE. A pickleball PADDLE is a SOLID, FLAT paddle with a broad rectangular/elongated face and rounded corners and a short handle — it is NOT a round table-tennis/ping-pong paddle. A PICKLEBALL is a hollow plastic ball COVERED IN ROUND HOLES (like a wiffle ball), NOT a smooth tennis ball or a solid sphere. Whenever the design includes a paddle or ball, name these specifics in the editPrompt so the image model renders real pickleball gear, not generic ping-pong/tennis.`,
          `8. CONVERT THE WHOLE SCENE — leave NO source-domain props behind. Every element tied to the source's theme must become a ${niche} element or be removed. (E.g. a camping source: tents, campfires, RVs, lanterns, fishing rods must each become a ${niche} activity/prop — a tent does NOT stay a tent.) If the source is a grid of N activities, produce N ${niche} activities. A half-converted design (pickleball text over a camper van) is a FAILURE.`,
          `9. conceptSummary — write ONE plain-English sentence describing the NEW design you are producing (subject + what they're doing + style), for a human to read on a product card. e.g. "Three capybaras playing pickleball around a glowing pickleball-moon, painterly vintage style." This MUST match the editPrompt's actual output. Empty string when canConvert is false.`,
          "10. NEVER ADD INVENTED ELEMENTS. Do not introduce objects, props, or decorations that are not in the source and are not a direct 1:1 replacement of a named source element. No wine glasses, drinks, extra balls/paddles, sparkles, banners, or 'lifestyle' flourishes. PO-flagged failure: a T-Rex tee got a random wine glass added — that is a hard FAIL. When in doubt, change LESS.",
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
            conceptSummary: { type: "string" },
          },
          required: ["canConvert", "fitReason", "bestMatch", "editPrompt", "conceptSummary"],
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
  spec.conceptSummary ??= "";
  console.log(
    `[PatternProd] nicheExpertPlan canConvert=${spec.canConvert} ` +
      `match="${spec.bestMatch?.item ?? ""}" editPromptChars=${spec.editPrompt.length} ` +
      `concept="${(spec.conceptSummary || "").slice(0, 80)}" ` +
      `reason="${(spec.fitReason || "").slice(0, 80)}"`
  );
  if (spec.editPrompt) {
    // Log the actual brain-written prompt (preview) so the live output is debuggable —
    // length alone hides whether the brain followed the five-part recipe / stayed on-brand.
    console.log(`[PatternProd] nicheExpertPlan editPrompt PREVIEW: "${spec.editPrompt.slice(0, 600)}${spec.editPrompt.length > 600 ? "…" : ""}"`);
  }
  return spec;
}

// ─── Curated mode: propose concept OPTIONS for the human to pick ──────────────

export type ConceptOption = { title: string; summary: string };

/**
 * Curated mode (PO Option C, 2026-06-08): instead of the brain auto-picking ONE
 * concept and generating, it proposes 2-3 DIVERSE, source-matched pickleball
 * concepts for the human to choose from (the way the PO's manual ChatGPT flow
 * offered options and they picked the llama). No editPrompt / no image — cheap.
 *
 * Reuses the same KB + rejection-learning as nicheExpertPlan, so the options are
 * on-brand, varied (rotate the palette, don't repeat the safe default), and avoid
 * the PO's past bad-transfer mistakes. Returns [] if the source can't convert.
 */
export async function proposeConcepts(
  sourceImageUrl: string,
  nicheProfile: any,
  fallbackNiche: string,
  product: string = "t-shirt",
  avoid: string[] = []
): Promise<ConceptOption[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured (proposeConcepts)");
  const knowledge = formatNicheKnowledge(nicheProfile);
  const niche =
    (typeof nicheProfile?.summary === "string" && nicheProfile.summary.split(",")[0]) ||
    nicheProfile?.niche || fallbackNiche || "the niche";
  const brainModel = process.env.BRAIN_MODEL || "gpt-5";

  const system = [
    `You are an expert print-on-demand designer for the "${niche}" niche. Look at the ACTUAL source ${product} image and propose THREE distinct concept options for adapting it to ${niche} — the kind a human would choose between.`,
    "",
    "Each option must:",
    "  - FULLY re-theme the source into the niche (not a surface word-swap that keeps the source's theme).",
    "  - Use a SPECIFIC, named item from the knowledge base (a mascot, a real catchphrase, a transferable concept) — and across the three options, USE DIFFERENT KB items (rotate the palette; don't propose three variations of the same phrase).",
    "  - Reuse the source's composition/structure (pose, count, layout) with only the identity changed.",
    "  - Render accurate niche detail (e.g. pickleball paddles are rectangular, balls are perforated).",
    "",
    "=== NICHE KNOWLEDGE BASE (your ONLY creative palette) ===",
    knowledge || `Niche: ${niche}.`,
    "=== END KNOWLEDGE BASE ===",
    ...(avoid.length ? [
      "",
      "=== LEARN FROM THE PO'S REJECTIONS (craft lessons about BAD transfers) ===",
      ...avoid.map((a, i) => `  ${i + 1}. ${a}`),
      "Do not propose any option that repeats these failures.",
      "=== END REJECTIONS ===",
    ] : []),
    "",
    "Return strict JSON: { canConvert: boolean, options: [{title, summary}] }.",
    "  - title: 3-5 word name of the concept (e.g. \"Stay Out Of The Kitchen\").",
    "  - summary: one plain sentence describing the design (subject + action + the source structure it reuses).",
    "  - 3 options when canConvert; [] when the source genuinely cannot become a clean " + niche + " design.",
  ].join("\n").replace(/\$\{product\}/g, product);

  const body = {
    model: brainModel,
    reasoning_effort: "medium" as const,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "image_url" as const, image_url: { url: sourceImageUrl, detail: "high" as const } },
        { type: "text" as const, text: `Propose 3 distinct ${niche} concept options for this source. Target niche: "${niche}".` },
      ] },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: "concept_options",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            canConvert: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { title: { type: "string" }, summary: { type: "string" } },
                required: ["title", "summary"],
              },
            },
          },
          required: ["canConvert", "options"],
        },
      },
    },
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`proposeConcepts API error (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!raw) return [];
  let parsed: { canConvert: boolean; options: ConceptOption[] };
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    console.warn(`[PatternProd] proposeConcepts: could not parse: ${raw.slice(0, 150)}`);
    return [];
  }
  const options = (parsed.canConvert ? parsed.options : []).slice(0, 3);
  console.log(`[PatternProd] proposeConcepts → ${options.length} options: ${options.map(o => o.title).join(" | ")}`);
  return options;
}

// ─── Step 4b: Output validation (foundational fix) ───────────────────────────

/**
 * Vision-LLM audit of the generated transparent design BEFORE storagePut.
 *
 * The original pipeline trusted every layer's output: brain plans X, gpt-image-1
 * does Y, nothing notices the drift. PO observed all four failure modes on a
 * single scan (2026-06-06):
 *   1. Off-niche design ("Don't Be Afraid" dandelion) scoring 85 via rank LLM
 *      (the rank LLM weights resonance + originality, not strict niche match)
 *   2. gpt-image-1 typography typos ("DINK VALLEY NATIONAL PART" — PARK; "STAY
 *      OUT OF THE RFICHEN" — KITCHEN). Known weakness on text >8 chars.
 *   3. Brain-plan vs image-output drift: pattern card said "T-Rex pickleball
 *      mascot on net" but the image showed a raccoon in flowers. The scan-time
 *      brain metadata didn't match what gpt-image-1 actually produced.
 *   4. Print-style flattening: vintage distressed source came out clean-vector.
 *
 * This auditor catches #1-#3 with one vision LLM call. (#4 is addressed by the
 * style-lock prompt strengthening in commit 10581f3.)
 *
 * Returns null on API failure → fail-open: ship the design without a report
 * rather than block production on transient infra issues.
 */
export type ValidationReport = {
  nicheRelevance: number;     // 0-100, how well the design depicts the niche
  matchesPlan: boolean;       // does the image match brain's bestMatch?
  textInImage: string;        // OCR-style read of any visible text
  textMatchesPlan: boolean;   // does the visible text match brain's intent AND is correctly spelled?
  hasTypo: boolean;           // is any visible word obviously misspelled?
  shouldShip: boolean;        // overall: ship to user or auto-dismiss?
  reasoning: string;          // 1-2 sentences explaining the shouldShip decision
};

async function validateNicheOutput(
  designPngBuf: Buffer,
  spec: EditSpec,
  niche: string
): Promise<ValidationReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[Validator] OPENAI_API_KEY missing — skipping validation");
    return null;
  }
  const dataUri = `data:image/png;base64,${designPngBuf.toString("base64")}`;
  // Validator defaults to gpt-4o — a fast vision model. This is a read-and-compare
  // check (OCR the text, judge niche fit, match against the plan), NOT a reasoning
  // task, so GPT-5's slow reasoning is wasted here (~15s/pattern). gpt-4o returns
  // in ~3-5s. Override with VALIDATOR_MODEL if needed.
  const validatorModel = process.env.VALIDATOR_MODEL || "gpt-4o";
  const isReasoningModel = validatorModel.startsWith("gpt-5") || validatorModel.startsWith("o");

  const systemPrompt = [
    `You are a quality auditor for print-on-demand designs in the "${niche}" niche.`,
    "",
    "A brain LLM planned an adaptation of a hot-selling shirt design. An image-gen",
    "model then produced it. You are shown the design PRINTED ON A SHIRT MOCKUP —",
    "judge ONLY the printed graphic artwork. Ignore the shirt fabric, shirt colour,",
    "folds, and the photo background; they are not part of the design.",
    "",
    "BRAIN PLANNED THIS:",
    `  bestMatch.type:  ${spec.bestMatch?.type ?? "(none)"}`,
    `  bestMatch.item:  ${spec.bestMatch?.item ?? "(none)"}`,
    `  bestMatch.why:   ${(spec.bestMatch?.why ?? "(no rationale)").slice(0, 200)}`,
    "",
    "INTENDED EDIT PROMPT (what image-gen was instructed to produce):",
    spec.editPrompt.slice(0, 1000),
    "",
    "Look at the printed graphic and return strict JSON:",
    `  - nicheRelevance:   integer 0-100. Does the printed graphic clearly depict the "${niche}" niche?`,
    "                       <60 = off-niche; >=60 = visibly on-niche.",
    "  - matchesPlan:      true if the graphic clearly depicts the bestMatch.item subject.",
    "                       false if it shows a different subject than planned.",
    "  - textInImage:      any visible words in the printed graphic (OCR-style read).",
    "  - textMatchesPlan:  true if the text matches what the editPrompt asked for AND",
    "                       every word is correctly spelled. false on ANY typo or off-plan text.",
    "  - hasTypo:          true if any visible word is misspelled (PART vs PARK, RFICHEN vs KITCHEN).",
    "  - shouldShip:       false if nicheRelevance < 60, OR hasTypo == true,",
    "                       OR matchesPlan == false. Otherwise true.",
    "  - reasoning:        1-2 sentences explaining your shouldShip decision (will be shown",
    "                       to the human as the dismissal reason if shouldShip=false).",
  ].join("\n");

  const body = {
    model: validatorModel,
    // reasoning_effort is a GPT-5/o-series param; gpt-4o rejects it with a 400.
    ...(isReasoningModel ? { reasoning_effort: "low" as const } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url" as const, image_url: { url: dataUri, detail: "low" as const } },
          { type: "text" as const, text: "Audit this design (shown printed on a shirt) and return the JSON." },
        ],
      },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: "design_validation",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nicheRelevance: { type: "integer", minimum: 0, maximum: 100 },
            matchesPlan: { type: "boolean" },
            textInImage: { type: "string" },
            textMatchesPlan: { type: "boolean" },
            hasTypo: { type: "boolean" },
            shouldShip: { type: "boolean" },
            reasoning: { type: "string" },
          },
          required: ["nicheRelevance", "matchesPlan", "textInImage", "textMatchesPlan", "hasTypo", "shouldShip", "reasoning"],
        },
      },
    },
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`[Validator] API error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!raw) {
      console.warn("[Validator] empty response");
      return null;
    }
    return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "")) as ValidationReport;
  } catch (e) {
    console.warn(`[Validator] Failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Append the workspace-level guardrails (AVOID + DTF print constraint) to the rich
 * prompt the brain wrote in `spec.editPrompt`.
 *
 * The brain (nicheExpertPlan) does the heavy lifting: it looks at the source image,
 * consults the knowledge base, and writes the SCENE/EDIT/NEW-DESIGN/STYLE/PRESERVATION
 * recipe directly — the way a human craftsperson writes one rich prompt to ChatGPT.
 * This function just adds the cross-cutting concern the brain shouldn't know about:
 * the AVOID list (from prior rejections).
 *
 * The DTF "bold solid shapes only, no halftone" print constraint was REMOVED
 * (PO directive 2026-06-07). It blanket-forced every design toward flat bold
 * shapes, which flattened painterly/photographic sources — the opposite of the
 * ground-truth transfers (the raccoon-pickleball keeps its painterly glow and
 * gradients). Print-style is now PRESERVED FROM THE SOURCE: a painterly source
 * stays painterly, a flat-cartoon source stays flat. DTF-printability for
 * block-heavy designs is handled later by the OPT-IN halftone step (applied per
 * design when the PO chooses it), not by constraining generation up front.
 */
export function buildEditPrompt(spec: EditSpec, avoid: string[] = [], _product: string = "t-shirt"): string {
  const avoidLine = avoid.length
    ? `AVOID (these were rejected on previous designs in this shop; do NOT repeat them): ${avoid.join("; ")}.`
    : null;
  return [
    (spec.editPrompt || "").trim(),
    ...(avoidLine ? [avoidLine] : []),
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
    `[PatternProd] Step 1 (gpt-image-1 quality=high + input_fidelity:high). Prompt: "${editPrompt.substring(0, 140)}..."`
  );
  // quality:"high" — reverted from "medium". Step 1 is the actual niche transfer (the
  // edit that swaps frogs->raccoons etc.); medium was a speed trade that cost edit
  // fidelity (PO-confirmed regression: flat-vector output, lost source texture). The
  // PO's ground-truth ChatGPT transfers used full quality + full thinking. The
  // structural speed fixes (parallel style extraction d3848db, parallel scrape
  // b32da43, atomic-claim race fix dfa4338) already recovered the scan time, so the
  // per-pattern quality trade is no longer needed.
  return callImageEdit(sourcePng, "source_shirt.png", editPrompt, {
    transparent: false,
    inputFidelity: "high",
    quality: "high",
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
  promptDescription: string,
  chosenConcept: string = ""
): Promise<{ productionDesignUrl: string | null; previewImageUrl: string | null }> {
  console.log(`[PatternProd] Processing pattern ${patternId}...${chosenConcept ? ` (curated concept: "${chosenConcept.slice(0,60)}")` : ""}`);

  // Step 0: NICHE-EXPERT evaluation — primed with the workspace's niche knowledge
  // base, it decides (1) can this be converted at all, (2) which knowledge-base
  // item fits this design best, (3) the minimal swaps.
  const ws = await getWorkspaceById(workspaceId);
  const product = await getWorkspaceProductType(workspaceId); // agentic: "t-shirt", "mug", etc.
  // Rejection-learning (PO directive 2026-06-08: "training/rejection reasons must be
  // taken seriously"). Fetch the workspace's AVOID list (dismissed patterns' reasons
  // + tags) BEFORE the brain runs and feed it INTO concept selection — not just the
  // edit prompt. Previously AVOID only hit buildEditPrompt (the image render), AFTER
  // the brain had already picked the concept, so the brain kept re-picking rejected
  // concepts (e.g. "dink responsibly" 3x). Now the brain sees what was rejected and
  // chooses a different, source-matched concept from the full KB palette.
  const avoid = await getWorkspaceAvoidList(workspaceId);
  const editSpec = await nicheExpertPlan(sourceImageUrl, ws?.nicheProfile ?? null, promptDescription, product, avoid, chosenConcept);

  // If the brain decides the source doesn't fit (canConvert=false), AUTO-DISMISS
  // the pattern with the fit reason — DO NOT throw. The previous behavior of
  // throwing NICHE_FIT_SKIP caused an infinite re-process loop: retryStuckPatterns
  // would catch the error silently, return "processed:id, remaining:N", but the
  // pattern stayed in stuck state. Next poll → same throw → same silent catch.
  // Patterns sat null prodHash for 37+ minutes (PO-confirmed: the poppy flowers).
  //
  // Auto-dismissing moves the pattern to status='dismissed' with the brain's
  // fitReason captured as rejectionReason. getStuckProductionPatterns excludes
  // dismissed (same commit), so retryStuckPatterns stops re-picking it. The
  // dismiss also feeds aggregateAvoidList for future scans/regens.
  if (!editSpec.canConvert) {
    const reason = editSpec.fitReason || "Source does not fit the niche";
    console.log(`[PatternProd] AUTO-DISMISS pattern=${patternId}: ${reason}`);
    await updateTrendPatternStatus(patternId, "dismissed");
    await recordRejectionSignal(patternId, reason, ["off_brand"]);
    return { productionDesignUrl: null, previewImageUrl: null };
  }
  // Card = image: overwrite the scan brain's adaptedConcept guess with the production
  // brain's plain-English summary of what it's ACTUALLY making. Kills the two-brain
  // disconnect (card said "T-Rex/Llama/Octopus" while the image was capybaras).
  // Non-fatal: a display update must never block production.
  if (editSpec.conceptSummary) {
    try {
      await updateTrendPatternConcept(patternId, editSpec.conceptSummary);
    } catch (e) {
      console.warn(`[PatternProd] updateTrendPatternConcept failed (non-fatal) for ${patternId}:`, e);
    }
  }

  // Reject-feedback also steers the image RENDER (not just concept selection above):
  // reuse the same `avoid` list fetched before the brain. Rejections now influence
  // BOTH what concept is chosen AND how it's rendered.
  const editPrompt = buildEditPrompt(editSpec, avoid, product);

  // Step 1: Surgically edit the source product photo using only the planned swaps.
  const shirtMockup = await replaceDesignOnShirt(sourceImageUrl, editPrompt);

  // Step 1b: OUTPUT VALIDATION — vision-LLM audit of the design vs brain's plan.
  // FLAG-ONLY (PO directive 2026-06-07: "Nothing should be automatically dismissed
  // if produced — but the system should be able to catch itself before doing
  // something"). The auditor reads the Step 1 mockup and records a validationReport
  // (typo / off-niche / plan-drift) so the UI can surface a ⚠️ warning chip and the
  // HUMAN decides whether to keep or flag-for-retry. It does NOT auto-dismiss: once
  // we've spent the compute to produce a design, we never silently throw it away.
  // (Pre-production catching still happens upstream — the canConvert fit gate skips
  // BEFORE any image-gen. That's "catch before doing"; this is post-production, so
  // it only flags.)
  // Computed niche string matches the one used inside nicheExpertPlan.
  const niche =
    (typeof ws?.nicheProfile === "object" && ws?.nicheProfile !== null && typeof (ws.nicheProfile as any).summary === "string"
      ? (ws.nicheProfile as any).summary.split(",")[0]
      : null) ||
    (ws?.nicheProfile as any)?.niche ||
    promptDescription ||
    "the niche";
  const validation = await validateNicheOutput(shirtMockup, editSpec, niche);
  if (validation) {
    console.log(
      `[PatternProd] Validation pattern=${patternId}: relevance=${validation.nicheRelevance} matchesPlan=${validation.matchesPlan} hasTypo=${validation.hasTypo} shouldShip=${validation.shouldShip} text="${validation.textInImage.slice(0, 60)}"`
    );
    await updateTrendPatternValidationReport(patternId, validation);
    if (!validation.shouldShip) {
      // FLAG, do not dismiss. The report is stored; the UI shows the warning; the
      // human curates. Production continues normally below.
      console.warn(`[PatternProd] ⚠️ pattern=${patternId} FLAGGED by validator (kept, not dismissed): ${validation.reasoning}`);
    }
  }
  // (When validation is null — API/auth failure — fall through and ship anyway.
  // Fail-open prevents transient infra issues from blocking production.)

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

  // Step 6: Composite onto EVERY workspace template — FAITHFULLY (no halftone by
  // default). PO directive 2026-06-07: halftone is OPT-IN, only for block-heavy
  // designs (e.g. the solid dark mass behind the raccoons), NOT forced on every
  // design — it would flatten painterly/photographic sources. So the default
  // preview places the design faithfully on each shirt; the per-design halftone
  // opt-in (a toggle that re-composites with shirt-aware halftone) is a separate
  // step. The applyShirtAwareHalftone path in mockupCompositor stays available for
  // that opt-in — it's just not invoked here.
  let previewImageUrl: string = productionDesignUrl; // legacy single-preview, populated with first composite
  const previewImageUrls: Array<{ templateId: string; colorHex: string; colorName: string; previewUrl: string }> = [];
  try {
    const groups = await getProductGroupsByWorkspace(workspaceId);
    const sortedGroups = groups
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const group of sortedGroups) {
      const templates = await getMockupsByGroup(group.id);
      const printAreaRelGarment = (group.printZone as { x: number; y: number; width: number; height: number } | null) ?? DEFAULT_PRINT_AREA;
      for (const template of templates) {
        try {
          const garmentBbox = await getGarmentBbox(template.id, template.imageUrl);
          const printZone = resolveZoneToPhoto(printAreaRelGarment, garmentBbox);
          const compositeBuffer = await compositeDesignOnMockup({
            designUrl: productionDesignUrl,
            mockupUrl: template.imageUrl,
            printZone,
            // shirtColorHex intentionally omitted — no forced halftone. Faithful
            // placement by default; halftone is the per-design opt-in (PO 2026-06-07).
          });
          const safeColorName = template.colorName.replace(/[^a-zA-Z0-9_-]+/g, "_");
          const previewKey = `pattern-preview/${patternId}-${safeColorName}-${Date.now()}.webp`;
          const { url } = await storagePut(previewKey, compositeBuffer, "image/webp");
          previewImageUrls.push({
            templateId: template.id,
            colorHex: template.colorHex,
            colorName: template.colorName,
            previewUrl: url,
          });
          if (previewImageUrls.length === 1) previewImageUrl = url; // legacy field = first preview
          console.log(`[PatternProd] previewImageUrl[${template.colorName}]: ${url}`);
        } catch (compErr) {
          console.warn(`[PatternProd] Composite failed for template ${template.colorName} (${template.colorHex}):`, compErr);
          // skip this template, keep going for the others
        }
      }
    }
    if (previewImageUrls.length === 0) {
      console.log(`[PatternProd] No templates yielded a preview for workspace ${workspaceId}, using transparent PNG as preview`);
    }
  } catch (err) {
    console.warn(`[PatternProd] Multi-template composite block failed, falling back to transparent PNG:`, err);
    previewImageUrl = productionDesignUrl;
  }

  // Step 7: Update preview fields in DB. previewImageUrl (legacy single) for the
  // current PatternCard render; previewImageUrls (array) for the new shirt-color gallery.
  await updateTrendPatternImage(patternId, previewImageUrl);
  if (previewImageUrls.length > 0) {
    await updateTrendPatternPreviewUrls(patternId, previewImageUrls);
  }
  console.log(`[PatternProd] Pattern ${patternId} done — ${previewImageUrls.length} per-shirt preview(s).`);

  return { productionDesignUrl, previewImageUrl };
}
