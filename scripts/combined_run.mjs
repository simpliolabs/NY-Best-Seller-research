/**
 * Combined production run: all three proven levers in one call.
 * a) Source image attached (for context)
 * b) Full 20-field styleJSON interpolated into prompt
 * c) Prompt framed as spike 2 inversion: "STYLE REFERENCE ONLY"
 * d) Explicit llama anatomy
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import { writeFileSync } from "fs";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const baseUrl = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;
const endpoint = new URL("images.v1.ImageService/GenerateImage", baseUrl).toString();

const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";

// 20-field styleJSON for this source (from DB, backfilled)
const styleJSON = {
  subject: "Bigfoot blowing a dandelion",
  composition: "centered single subject",
  artStyle: "illustrated",
  mood: "whimsical",
  primaryColors: ["#7c5c55", "#b8b082", "#4a322a", "#3e443c"],
  technique: "screen-print simulation",
  lineWeight: "medium outlines",
  shadingMethod: "flat color",
  textureDetail: "hand-drawn organic",
  designEra: "timeless/classic",
  inkColors: ["light brown"],
  inkColorNames: ["khaki brown"],
  shirtColorRole: "background canvas",
  subjectCrop: "bust/chest-up",
  framingDevice: "NONE",
  textStyle: "NONE",
  backgroundTreatment: "transparent/shirt-is-background",
  printPlacement: "centered chest",
  distressLevel: "moderate vintage wear",
  signatureElements: "dandelion seeds floating away"
};

// Combined prompt: spike-2 inversion + full 20-field style descriptors
const prompt = `Generate a llama blowing a dandelion with seeds floating away.

The reference image is a STYLE REFERENCE ONLY — do not preserve the character's silhouette, body shape, fur texture, or facial features. The Bigfoot/Sasquatch in the reference exists solely to demonstrate the visual style, line treatment, and composition.

The output character must be unmistakably a LLAMA:
- Long neck (llama proportions, not ape proportions)
- Llama head shape (elongated snout, not flat primate face)
- Pointed llama ears (tall, banana-shaped)
- Llama body proportions (slender neck, no broad shoulders)
- No Bigfoot fur, no Bigfoot face, no ape-like hands

STYLE TO MATCH (from source):
- Technique: ${styleJSON.technique}
- Line weight: ${styleJSON.lineWeight}
- Shading method: ${styleJSON.shadingMethod}
- Texture detail: ${styleJSON.textureDetail}
- Design era: ${styleJSON.designEra}
- Ink colors: ${styleJSON.inkColors.join(", ")} (${styleJSON.inkColorNames.join(", ")})
- Composition: ${styleJSON.composition}
- Subject crop: ${styleJSON.subjectCrop}
- Background: ${styleJSON.backgroundTreatment}
- Print placement: ${styleJSON.printPlacement}
- Distress level: ${styleJSON.distressLevel}
- Signature elements: ${styleJSON.signatureElements}
- Palette: ${styleJSON.primaryColors.join(", ")}

The llama holds the dandelion stem, blowing seeds that float away. Bust portrait, single ink color (khaki/tan), screen-print style with visible line work and hand-drawn organic texture. Transparent background. Timeless vintage aesthetic with moderate distress/wear.`;

console.log("COMBINED PRODUCTION RUN");
console.log("=======================");
console.log(`\nPrompt (${prompt.length} chars):\n${prompt}\n`);
console.log(`Source image: ${SOURCE_IMAGE_URL}`);
console.log(`\nCalling Forge...`);

const resp = await fetch(endpoint, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${FORGE_KEY}`,
  },
  body: JSON.stringify({
    prompt,
    original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
  }),
  signal: AbortSignal.timeout(120000),
});

console.log(`HTTP ${resp.status}`);
const data = await resp.json();

if (data?.image?.b64Json) {
  const buf = Buffer.from(data.image.b64Json, "base64");
  const path = "/home/ubuntu/webdev-static-assets/combined_run_llama.png";
  writeFileSync(path, buf);
  console.log(`\nImage saved: ${path} (${buf.length} bytes)`);
  console.log("\nDone. Upload with: manus-upload-file /home/ubuntu/webdev-static-assets/combined_run_llama.png");
} else {
  console.log("ERROR: No image in response");
  console.log(JSON.stringify(data).slice(0, 500));
}
