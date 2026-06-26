/**
 * Mockup Council (PO 2026-06-25). In AUTOMATIC mode, a vision+signals LLM looks at a design and decides
 * how it should be treated for print so the seller doesn't have to know "scene vs subject":
 *   cutout   — isolate a subject sitting on a plain background (BiRefNet matting)
 *   blend    — fade a full SCENE into a dark garment (luminance key)
 *   knockout — delete a flat color so the garment shows through
 *   none     — already clean / transparent; print as-is
 * Mirrors the niche design council (pipeline.ts): same invokeLLM (default gemini-2.5-flash), JSON out,
 * deterministic signals injected as priors. It RECOMMENDS — the chosen treatment is applied explicitly
 * upstream of the compositor (CP2: never silent). Low confidence floors to a non-destructive default
 * (cutout, or none for already-transparent art) so a misjudged design is never melted.
 */
import sharp from "sharp";
import { invokeLLM } from "./_core/llm";
import { classifyDesignType } from "./designType";
import { analyzeGarmentFit } from "./garmentFit";
import type { TreatmentType } from "./treatmentEngine";

export interface MockupVerdict {
  treatment: TreatmentType;
  reason: string;
  garmentColors: string[];
  printFile: "fulltone" | "halftone" | "knockout";
  confidence: number;
}

const SYSTEM = `You are the Mockup Council, an expert DTF/screen-print production director. You receive ONE
design image plus deterministic signal priors and decide how to TREAT that design so it prints
correctly on a garment. You do NOT redraw the art — you pick a treatment, garment colors, and a
print-file format. When unsure, prefer the safe default and LOWER your confidence.

TREATMENTS (pick exactly one):
- "cutout"   = isolate the subject on transparency (matting). Use for a discrete SUBJECT/logo/character
               sitting on a PLAIN or empty background, or a photoreal subject to float clean on a shirt.
- "blend"    = fade dark/desaturated pixels so a full SCENE melts into a DARK garment while the lit
               subject + saturated colors survive. Use ONLY for a photoreal full-SCENE design (the
               background is part of the art: sky, forest, smoke, street) printed on a dark shirt.
- "knockout" = flood-delete a flat color so the garment shows through. Use for stylized / limited-color
               art with large flat color fields.
- "none"     = the art already prints as-is (already transparent PNG, clean line art).

PRINT FILE (pick exactly one): "fulltone" (full-color DTF, default for photoreal/many-color),
"halftone" (limited-color/stylized screen look), "knockout" (pair with the knockout treatment).

DECISION ORDER:
1. SUBJECT-on-plain-bg vs full-SCENE is the pivotal call — judge it from the IMAGE, not the color
   count. A forest/sky/room/street BEHIND the subject => SCENE => "blend" (dark shirt only). An
   empty/white/solid backdrop or a studio gradient => SUBJECT => "cutout".
2. If alreadyTransparent is true, the art is already cut out => "none" unless it clearly needs a color
   knocked out.
3. Flat limited-color art with big solid fields => "knockout", OR "cutout" + "halftone" for a vintage
   screen look.
4. Honor the signal priors unless the image clearly contradicts them; if it does, say so in "reason"
   and drop confidence below 0.6.
5. garmentColors: 1-3 hex colors maximizing contrast with the design's dominant tones, respecting
   recommendDarkShirt/recommendLightShirt. "blend" REQUIRES a dark garment.

OUTPUT: a single JSON object, no prose:
{"treatment":"cutout|blend|knockout|none","reason":"one sentence","garmentColors":["#000000"],"printFile":"fulltone|halftone|knockout","confidence":0.0-1.0}`;

/** Fraction of meaningfully-transparent pixels — tells us the art is already cut out. */
async function transparentShare(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).ensureAlpha().resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let clear = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 200) clear++;
  return clear / n;
}

function normalizeVerdict(raw: unknown): MockupVerdict {
  const o = (raw ?? {}) as Record<string, unknown>;
  const treatment = (["none", "cutout", "blend", "knockout"].includes(o.treatment as string) ? o.treatment : "cutout") as TreatmentType;
  const printFile = (["fulltone", "halftone", "knockout"].includes(o.printFile as string) ? o.printFile : "fulltone") as MockupVerdict["printFile"];
  const garmentColors = Array.isArray(o.garmentColors)
    ? (o.garmentColors as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 3)
    : [];
  const confidence = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
  return {
    treatment,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 280) : "",
    garmentColors,
    printFile,
    confidence,
  };
}

/** Decide the treatment for a design. `designUrl` must be a reachable URL (the council sends it to the
 *  vision model). Returns a safe, non-destructive verdict even when the LLM is unavailable. */
export async function runMockupCouncil(designUrl: string): Promise<MockupVerdict> {
  const srcBuf = Buffer.from(await (await fetch(designUrl)).arrayBuffer());
  const [cls, fit, clearShare] = await Promise.all([
    classifyDesignType(srcBuf),
    analyzeGarmentFit(srcBuf),
    transparentShare(srcBuf),
  ]);
  const alreadyTransparent = clearShare > 0.25;

  let verdict: MockupVerdict;
  try {
    const res = await invokeLLM({
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `signals: type=${cls.type}, confidence=${cls.confidence}, distinctColors=${cls.distinctColors}, topColorShare=${cls.topColorShare}, recommendDarkShirt=${fit.recommendDarkShirt}, recommendLightShirt=${fit.recommendLightShirt}, lightShare=${fit.lightShare}, needsUnderbase=${fit.needsUnderbase}, alreadyTransparent=${alreadyTransparent}`,
            },
            { type: "image_url", image_url: { url: designUrl, detail: "low" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });
    const content = typeof res.choices[0]?.message?.content === "string" ? res.choices[0].message.content : "{}";
    verdict = normalizeVerdict(JSON.parse(content));
  } catch (err) {
    console.warn("[MockupCouncil] LLM failed — using safe default:", err);
    verdict = {
      treatment: alreadyTransparent ? "none" : "cutout",
      reason: "Couldn't analyze automatically — used a safe clean cutout.",
      garmentColors: [],
      printFile: "fulltone",
      confidence: 0,
    };
  }

  // Low-confidence floor (adversary F3): never auto-apply a destructive treatment on a guess.
  // Already-transparent art → none (don't re-matte clean art); otherwise cutout (matting keeps the
  // whole subject — non-destructive).
  if (verdict.confidence < 0.6) {
    verdict = {
      ...verdict,
      treatment: alreadyTransparent ? "none" : "cutout",
      printFile: "fulltone",
      reason: `${verdict.reason} (Low confidence — used the safe default.)`.trim(),
    };
  }

  // Blend prints a full SCENE onto a DARK shirt (the scene fades into the fabric). It is the PO's
  // intended default for dark-content scenes like the raccoon (PO 2026-06-25, "BLEND as I requested"),
  // so we TRUST the council's scene call — the vision model is what distinguishes a scene from a
  // subject-on-a-plain-background. We only override blend when the art is already transparent (there's
  // no scene/background to fade → cut out instead). The dark-garment requirement is satisfied
  // DOWNSTREAM (blend forces the darkest garments in mockup.generate), not by demoting blend here —
  // demoting on garment-fit was wrong, since a dark design reads "light shirt" yet blends on dark.
  // Low-confidence blends already fell back to the safe default above.
  if (verdict.treatment === "blend" && alreadyTransparent) {
    verdict = {
      ...verdict,
      treatment: "cutout",
      reason: `${verdict.reason} (Already a clean cutout — nothing to blend.)`.trim(),
    };
  }

  return verdict;
}
