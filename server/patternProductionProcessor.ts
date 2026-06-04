/**
 * Pattern Production Processor — v4 (Two-Call Edit→Extract)
 *
 * Two-step pipeline mirroring the PO's proven ChatGPT workflow:
 *
 *   Step 1 — REPLACE: gpt-image-1 /edits on the FULL uncropped shirt photo.
 *     Prompt: "Edit this t-shirt mockup. Replace the design with: {promptDescription}.
 *              Keep the shirt, background, props, and lighting unchanged."
 *     Output: opaque shirt mockup with new design printed on it.
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
 * Why gpt-image-1 (not gpt-image-2) for both calls:
 * gpt-image-2 returns HTTP 400 for background:"transparent" on /v1/images/edits
 * ("Transparent background is not supported for this model"). gpt-image-1 honors it.
 * Verified by direct API capability test.
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
} from "./nicheHunterDb";
import { invokeLLM } from "./_core/llm";

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
  /** "text-only" is routed to the guaranteed font-composite fallback downstream. */
  designType: "text-only" | "text-and-graphic" | "illustration" | "other";
  /** Everything in the source that must remain pixel-identical. */
  preserve: string;
  /** Exact visible words to change → niche equivalent, same font/size/position. */
  textSwaps: Array<{ from: string; to: string }>;
  /** Non-niche subjects/objects → niche equivalent, same art style/position/scale. */
  subjectSwaps: Array<{ from: string; to: string }>;
  /** New elements. MUST default to empty — at most one short text token if required. */
  additions: string[];
};

/**
 * Look at the ACTUAL source design and return the minimal set of swaps that make
 * it niche-appropriate — grounded in pixels, not in a text description. The hard
 * rule baked into the prompt: ADD NOTHING that is not already in the source
 * (except, at most, one short text token the niche genuinely requires).
 *
 * `nicheContext` is used ONLY to choose replacement words/subjects; the planner is
 * told explicitly not to import any object or scene mentioned in it.
 */
async function planMinimalEdit(
  sourceImageUrl: string,
  nicheContext: string
): Promise<EditSpec> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: [
          "You are a print-on-demand design editor. You plan the MINIMAL edit that adapts an existing t-shirt design to a target niche while preserving the original design as faithfully as possible.",
          "You are shown the ACTUAL source design. Base your plan ONLY on what is literally visible in it.",
          "",
          "HARD RULES:",
          "1. PRESERVE everything by default — composition, layout, every figure/character, typography, font, lettering, colours, textures, art style. Describe what must stay unchanged in `preserve`.",
          "2. CHANGE ONLY what is specific to the source's ORIGINAL theme and would not read as the target niche. Put exact word changes in `textSwaps` (copy the source words verbatim into `from`). Put subject/object changes in `subjectSwaps`.",
          "3. NEVER redraw or restyle a figure/character that can simply stay. Example: a woman holding an umbrella stays EXACTLY as drawn — you do not redraw her; you only change text or add nothing.",
          "4. ADD NOTHING. `additions` MUST be empty unless the niche is literally unreadable without one short text token — then at most ONE, and only text. No new graphics, props, paddles, balls, mascots, badges, or decorative wordmarks.",
          "5. If the source has NO text, add NO text. If the source is a complex illustration, prefer a few subject swaps over rebuilding the scene.",
          "6. Set `designType`: 'text-only' if essentially just lettering; 'text-and-graphic' if lettering plus a graphic; 'illustration' if a pictorial scene with little/no text; else 'other'.",
        ].join("\n"),
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
            text: `Target niche context — use this ONLY to choose replacement words/subjects. It is NOT a design to draw; do NOT import any object, prop, or scene mentioned in it that is not already visible in the source: ${nicheContext}`,
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "minimal_edit_plan",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            designType: {
              type: "string",
              enum: ["text-only", "text-and-graphic", "illustration", "other"],
            },
            preserve: { type: "string" },
            textSwaps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { from: { type: "string" }, to: { type: "string" } },
                required: ["from", "to"],
              },
            },
            subjectSwaps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { from: { type: "string" }, to: { type: "string" } },
                required: ["from", "to"],
              },
            },
            additions: { type: "array", items: { type: "string" } },
          },
          required: ["designType", "preserve", "textSwaps", "subjectSwaps", "additions"],
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => ("text" in c ? c.text : "")).join("")
        : "";
  if (!raw.trim()) {
    throw new Error("[PatternProd] planMinimalEdit: empty LLM response");
  }

  let spec: EditSpec;
  try {
    spec = JSON.parse(
      raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "")
    ) as EditSpec;
  } catch {
    throw new Error(
      `[PatternProd] planMinimalEdit: could not parse edit plan: ${raw.slice(0, 200)}`
    );
  }
  spec.textSwaps ??= [];
  spec.subjectSwaps ??= [];
  spec.additions ??= [];
  console.log(
    `[PatternProd] planMinimalEdit type=${spec.designType} ` +
      `textSwaps=${spec.textSwaps.length} subjectSwaps=${spec.subjectSwaps.length} ` +
      `additions=${spec.additions.length} preserve="${(spec.preserve || "").slice(0, 60)}…"`
  );
  return spec;
}

/**
 * Render an EditSpec into a strict, deterministic Step-1 edit instruction.
 * Enumerates the literal swaps and explicitly locks everything else — the image
 * model is told exactly what to change and that nothing else may move.
 */
function buildEditPrompt(spec: EditSpec): string {
  const textLines = spec.textSwaps.length
    ? spec.textSwaps
        .map(
          (s) =>
            `  - change the text "${s.from}" to "${s.to}" — keep the identical font, size, weight, colour, position, and distressing`
        )
        .join("\n")
    : "  - (no text changes)";

  const subjLines = spec.subjectSwaps.length
    ? spec.subjectSwaps
        .map(
          (s) =>
            `  - replace ${s.from} with ${s.to} — identical art style, position, and scale`
        )
        .join("\n")
    : "  - (no subject changes)";

  const addLines = spec.additions.length
    ? spec.additions.map((a) => `  - ${a}`).join("\n")
    : "  - nothing. Add NO new text, graphics, props, badges, mascots, or marks.";

  return [
    "Edit the printed graphic on this t-shirt IN PLACE. This is a surgical find-and-replace on the EXISTING design — NOT a redesign.",
    `PRESERVE COMPLETELY — keep pixel-identical; do not redraw, restyle, recolour, reposition, or resize: ${spec.preserve}. Every element not explicitly listed below must remain exactly as in the original.`,
    "TEXT CHANGES (the only text edits allowed):",
    textLines,
    "SUBJECT CHANGES (the only subject edits allowed):",
    subjLines,
    "ADD:",
    addLines,
    "Do NOT recompose, re-letter, redraw, or add anything beyond the explicit changes above. Someone seeing both designs must recognise them as the SAME design with only those swaps made.",
    "Keep the shirt, fabric, background, lighting, folds, and photo composition completely unchanged.",
  ].join("\n");
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
  const imgResp = await fetch(sourceImageUrl);
  if (!imgResp.ok) {
    throw new Error(`Failed to download source image: ${imgResp.status}`);
  }
  const sourcePng = await sharp(Buffer.from(await imgResp.arrayBuffer()))
    .png()
    .toBuffer();

  // The edit instruction is built upstream by buildEditPrompt() from a
  // vision-grounded EditSpec: it enumerates the literal swaps and locks
  // everything else. input_fidelity:"high" is the API-level lever that makes the
  // model actually honour "preserve everything not listed" rather than silently
  // re-rendering the whole canvas (the cause of the redrawn figure / re-lettered
  // text the PO flagged).
  console.log(
    `[PatternProd] Step 1 (surgical replace, input_fidelity=high). Prompt: "${editPrompt.substring(0, 140)}..."`
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
async function extractTransparentFromShirt(shirtMockup: Buffer): Promise<Buffer> {
  const prompt = [
    "Extract ONLY the printed graphic artwork from this t-shirt mockup.",
    "Remove the t-shirt garment entirely — no fabric, no collar, no sleeves, no seams, no shirt silhouette.",
    "Remove all photo background.",
    "Output only the flat 2D printed design itself on a fully transparent background, trimmed tightly to the artwork.",
    "Do NOT keep the shirt. The shirt is not part of the design.",
  ].join(" ");
  console.log(`[PatternProd] Step 2 (extract). Prompt: "${prompt.substring(0, 100)}..."`);
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

  // Step 0: Look at the ACTUAL source design and plan the minimal niche swaps.
  // Replaces the prose adaptedConcept (a from-scratch brief that instructed the
  // model to ADD paddles/wordmarks/props and REDRAW figures) with a pixel-grounded
  // spec that forbids adding anything not already present in the source.
  const editSpec = await planMinimalEdit(sourceImageUrl, promptDescription);
  const editPrompt = buildEditPrompt(editSpec);

  // Step 1: Surgically edit the source shirt photo using only the planned swaps.
  const shirtMockup = await replaceDesignOnShirt(sourceImageUrl, editPrompt);

  // Step 2: Extract just the design onto a transparent canvas
  const rawTransparent = await extractTransparentFromShirt(shirtMockup);

  // Step 3: Crop to content bounding box
  const transparentPng = await cropToContent(rawTransparent);

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
