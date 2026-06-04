/**
 * Pattern Production Processor — v4 (Two-Call Edit→Extract)
 *
 * Two-step pipeline (edit → extract):
 *
 *   Step 1 — REPLACE: FLUX.1 Kontext [pro] (via fal) edits the printed graphic on
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

// ─── FLUX.1 Kontext [pro] caller (fal queue API) ─────────────────────────────

/**
 * Edit an image with FLUX.1 Kontext [pro] via the fal queue API; return the
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

  const submit = await fetch("https://queue.fal.run/fal-ai/flux-pro/kontext", {
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
  designType: "text-only" | "text-and-graphic" | "illustration" | "other";
  /** Everything in the source that must remain pixel-identical. */
  preserve: string;
  /** The target niche, e.g. "pickleball". */
  niche: string;
  /** Niche signature gear (paddle, net, ball) — integrated ONLY on the VISUAL route. */
  nicheEquipment: string[];
  /** Literal text edits from the source (e.g. SALTY -> SALTY DINKER). The ONLY text
   *  changes; empty on the VISUAL route. */
  textSwaps: Array<{ from: string; to: string }>;
  /** Main subjects/characters visible in the source (for VISUAL-route integration). */
  subjects: string[];
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
          "You are a print-on-demand design editor. You plan the MINIMAL edit that adapts an existing t-shirt design to a target niche while preserving the original as faithfully as possible.",
          "You are shown the ACTUAL source design. Base your plan ONLY on what is literally visible in it.",
          "",
          "STEP A — from the niche context, set `niche` (e.g. 'pickleball') and `nicheEquipment` = the niche's signature gear (for pickleball: 'a solid pickleball paddle with a short handle', 'a pickleball net', 'a perforated pickleball'). The context's scenes, props, taglines and tone are NOT instructions — ignore them.",
          "STEP B — pick ONE adaptation route:",
          "  ROUTE TEXT — if the design has lettering/a wordmark that can be made niche-relevant by changing words: put the exact changes in `textSwaps` (copy the source words verbatim into `from`), e.g. 'SALTY' -> 'SALTY DINKER'. On this route you add NO new visual elements at all — no paddles, balls, props, or graphics.",
          "  ROUTE VISUAL — if the design has NO usable text (a pure illustration): leave `textSwaps` EMPTY. The niche is conveyed by integrating `nicheEquipment` into the existing subjects, so fill `subjects` and `nicheEquipment` well.",
          "",
          "HARD RULES:",
          "1. PRESERVE everything by default — composition, layout, every figure/character, typography, font, colours, textures, art style. Put what must stay unchanged in `preserve`.",
          "2. NEVER redraw or restyle a figure/character that can simply stay (a woman under an umbrella stays EXACTLY as drawn).",
          "3. NEVER invent text. The ONLY text in the output is the source's text with your `textSwaps` applied. NO taglines, slogans, subtitles, nutrition-label parodies, brand names, or descriptive copy — ever.",
          "4. List the main subjects/characters visible in the source in `subjects`.",
          "5. Set `designType`: 'text-only' (just lettering), 'text-and-graphic' (lettering + a graphic), 'illustration' (pictorial, little/no text), or 'other'.",
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
            text: `Niche context — use it ONLY to identify the target niche, its equipment, and any intended wordmark text. It is NOT a design to draw: ignore its scenes, props, taglines, and tone; never import them: ${nicheContext}`,
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
            niche: { type: "string" },
            nicheEquipment: { type: "array", items: { type: "string" } },
            textSwaps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { from: { type: "string" }, to: { type: "string" } },
                required: ["from", "to"],
              },
            },
            subjects: { type: "array", items: { type: "string" } },
          },
          required: ["designType", "preserve", "niche", "nicheEquipment", "textSwaps", "subjects"],
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
  spec.subjects ??= [];
  spec.nicheEquipment ??= [];
  const route = spec.textSwaps.length > 0 ? "TEXT" : "VISUAL";
  console.log(
    `[PatternProd] planMinimalEdit type=${spec.designType} route=${route} niche="${spec.niche}" ` +
      `textSwaps=${spec.textSwaps.length} subjects=${spec.subjects.length} ` +
      `nicheEquipment=${spec.nicheEquipment.length} preserve="${(spec.preserve || "").slice(0, 60)}…"`
  );
  return spec;
}

/**
 * Render an EditSpec into a deterministic Step-1 edit instruction, routed by class.
 *
 * TEXT route (textSwaps present): change ONLY the words, add no visual elements —
 * keeps figure designs like "Salty" clean (just the wordmark swap, no invented
 * taglines/props). VISUAL route (no text): integrate the niche equipment into the
 * existing subjects so a no-text illustration like the dino scene actually reads
 * as the niche. Either way: never invent text, preserve everything else, DTF-safe.
 *
 * The free-form "additions" field was removed — it was where the LLM smuggled in
 * taglines and stray props. Routing replaces it with bounded, class-specific rules.
 */
function buildEditPrompt(spec: EditSpec, avoid: string[] = []): string {
  const preserveLine = `PRESERVE COMPLETELY (keep pixel-identical; do not redraw, restyle, recolour, reposition, or resize): ${spec.preserve}. Keep the shirt, fabric, background, lighting, and composition unchanged.`;
  const noInventText = "NEVER invent text — no taglines, slogans, subtitles, brand names, or descriptive copy of any kind. The only text allowed is listed above (if any).";
  const dtf = "PRINT CONSTRAINT (DTF): bold, solid shapes only — no thin hairlines, stipple, halftone, or small scattered dots; render any rain/sparkle/texture as a few BOLD solid strokes or omit it.";
  // Reject-feedback: prior rejected reasons/tags, injected so we stop repeating them.
  const avoidLine = avoid.length
    ? `AVOID — these were rejected on previous designs in this shop; do NOT repeat them: ${avoid.join("; ")}.`
    : null;
  const tail = [preserveLine, noInventText, ...(avoidLine ? [avoidLine] : []), dtf];

  if (spec.textSwaps.length > 0) {
    // TEXT route — change only the words, add nothing visual.
    const textLines = spec.textSwaps
      .map(
        (s) =>
          `  - change the text "${s.from}" to "${s.to}" — keep the identical font, size, weight, colour, position, and texture`
      )
      .join("\n");
    return [
      "Edit the printed graphic on this t-shirt IN PLACE — a surgical edit of the EXISTING design, NOT a redesign.",
      "TEXT CHANGES are the ONLY changes allowed. Do not add, remove, redraw, or restyle any graphic, figure, or prop:",
      textLines,
      ...tail,
    ].join("\n");
  }

  // VISUAL route — no usable text: integrate niche gear into the existing subjects.
  const gear = spec.nicheEquipment.length ? spec.nicheEquipment.join(", ") : `${spec.niche} equipment`;
  const subjects = spec.subjects.length ? spec.subjects.join(", ") : "the existing subjects";
  const NICHE = (spec.niche || "the niche").toUpperCase();
  return [
    "Edit the printed graphic on this t-shirt IN PLACE — keep the original artwork and art style; only make it clearly about the niche.",
    `MAKE IT UNMISTAKABLY ${NICHE}: integrate ${gear} into the existing subjects (${subjects}) — put the equipment in their hands and into the scene so a viewer instantly recognises ${spec.niche || "the niche"}. Keep every subject and the art style exactly as drawn.`,
    "Add NO text or wordmark of any kind.",
    ...tail,
  ].join("\n");
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
async function getWorkspaceAvoidList(workspaceId: string): Promise<string[]> {
  try {
    const dismissed = await getTrendPatternsByWorkspace(workspaceId, "dismissed");
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of dismissed) {
      const reason = (p.rejectionReason ?? "").trim();
      if (reason && !seen.has(reason.toLowerCase())) {
        seen.add(reason.toLowerCase());
        out.push(reason);
      }
      for (const tag of ((p.rejectionTags as string[] | null) ?? [])) {
        const label = tag.replace(/_/g, " ").trim();
        if (label && !seen.has(label)) {
          seen.add(label);
          out.push(label);
        }
      }
    }
    const capped = out.slice(0, 8);
    if (capped.length) {
      console.log(`[PatternProd] reject-feedback: ${capped.length} AVOID item(s) for workspace ${workspaceId}`);
    }
    return capped;
  } catch (e) {
    console.warn(`[PatternProd] getWorkspaceAvoidList failed (non-fatal):`, e);
    return [];
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
  // Step 1 uses FLUX.1 Kontext [pro] (via fal): an instruction-edit model that
  // changes only the printed graphic and preserves the rest of the photo by
  // design. This replaces gpt-image-1, which re-rendered the whole canvas and
  // would redraw figures / invent props (the redrawn-lady, salt-shaker, and
  // fake-brand failures). Verified in a 3-design bake-off vs Qwen-Image-Edit:
  // Kontext preserved text, figure, AND illustration style across all three.
  // The edit instruction comes from planMinimalEdit() + buildEditPrompt(); fal
  // fetches `sourceImageUrl` server-side, so no local download is needed.
  console.log(
    `[PatternProd] Step 1 (Kontext [pro] in-place edit). Prompt: "${editPrompt.substring(0, 140)}..."`
  );
  return callFalKontextEdit(sourceImageUrl, editPrompt);
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

  // Step 0: Look at the ACTUAL source design and plan the minimal niche swaps.
  // Replaces the prose adaptedConcept (a from-scratch brief that instructed the
  // model to ADD paddles/wordmarks/props and REDRAW figures) with a pixel-grounded
  // spec that forbids adding anything not already present in the source.
  const editSpec = await planMinimalEdit(sourceImageUrl, promptDescription);
  // Reject-feedback: inject the workspace's previously-rejected reasons so the
  // regeneration avoids repeating mistakes the PO already dismissed.
  const avoid = await getWorkspaceAvoidList(workspaceId);
  const editPrompt = buildEditPrompt(editSpec, avoid);

  // Step 1: Surgically edit the source shirt photo using only the planned swaps.
  const shirtMockup = await replaceDesignOnShirt(sourceImageUrl, editPrompt);

  // Step 2: Extract just the design onto a transparent canvas
  const rawTransparent = await extractTransparentFromShirt(shirtMockup);

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
