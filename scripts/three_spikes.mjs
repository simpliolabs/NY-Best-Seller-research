/**
 * Three diagnostic spikes — run sequentially, paste all results.
 * 
 * Spike 1: Forge parameter probe — test strength, denoising_strength, image_weight,
 *          init_image_strength, mode, reference_type
 * Spike 2: Prompt inversion — reframe source as style reference only, demand llama silhouette
 * Spike 3: Pure prompt_only — generate llama from styleJSON + concept, NO source image
 *
 * Run: node scripts/three_spikes.mjs
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import { writeFileSync } from "fs";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const baseUrl = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;
const imgEndpoint = new URL("images.v1.ImageService/GenerateImage", baseUrl).toString();

const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";

async function callForge(body, label) {
  console.log(`\n  Calling Forge: ${label}...`);
  const resp = await fetch(imgEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const status = resp.status;
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status, text: text.slice(0, 500), parsed, hasImage: !!parsed?.image?.b64Json };
}

function saveImage(b64, filename) {
  const buf = Buffer.from(b64, "base64");
  const path = `/home/ubuntu/webdev-static-assets/${filename}`;
  writeFileSync(path, buf);
  return path;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPIKE 1: Forge parameter probe
// ═══════════════════════════════════════════════════════════════════════════════
console.log("═".repeat(70));
console.log("SPIKE 1: Forge Parameter Probe");
console.log("═".repeat(70));

const basePrompt = "A llama blowing a dandelion, bust portrait, single ink color (khaki/tan), screen-print simulation, medium outlines, hand-drawn organic texture, transparent background, timeless/classic design era.";

const probeParams = [
  { name: "strength=0.2", extra: { strength: 0.2 } },
  { name: "strength=0.9", extra: { strength: 0.9 } },
  { name: "denoising_strength=0.2", extra: { denoising_strength: 0.2 } },
  { name: "denoising_strength=0.9", extra: { denoising_strength: 0.9 } },
  { name: "image_weight=0.2", extra: { image_weight: 0.2 } },
  { name: "image_weight=0.9", extra: { image_weight: 0.9 } },
  { name: "init_image_strength=0.2", extra: { init_image_strength: 0.2 } },
  { name: "init_image_strength=0.9", extra: { init_image_strength: 0.9 } },
  { name: "mode=style_reference", extra: { mode: "style_reference" } },
  { name: "mode=img2img", extra: { mode: "img2img" } },
  { name: "reference_type=style", extra: { reference_type: "style" } },
  { name: "reference_type=content", extra: { reference_type: "content" } },
  { name: "control_mode=style", extra: { control_mode: "style" } },
  { name: "fidelity=0.2", extra: { fidelity: 0.2 } },
  { name: "style_fidelity=0.2", extra: { style_fidelity: 0.2 } },
];

console.log(`\nTesting ${probeParams.length} parameter variations against GenerateImage endpoint.`);
console.log(`Base prompt: "${basePrompt.slice(0, 80)}..."`);
console.log(`Source image: ${SOURCE_IMAGE_URL.slice(0, 60)}...`);
console.log("");

const spike1Results = [];
for (const probe of probeParams) {
  const body = {
    prompt: basePrompt,
    original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
    ...probe.extra,
  };
  const result = await callForge(body, probe.name);
  const row = {
    param: probe.name,
    httpStatus: result.status,
    accepted: result.status === 200,
    producedImage: result.hasImage,
    errorSnippet: result.status !== 200 ? result.text.slice(0, 150) : null,
  };
  spike1Results.push(row);
  console.log(`  [${row.httpStatus}] ${probe.name} → image=${row.producedImage}${row.errorSnippet ? ` | err: ${row.errorSnippet.slice(0, 80)}` : ""}`);
}

// For any that produced images with different strengths, save the most interesting ones
console.log("\n--- Spike 1 Summary ---");
console.log("Param | HTTP | Accepted | Image");
console.log("-".repeat(60));
for (const r of spike1Results) {
  console.log(`${r.param.padEnd(30)} | ${r.httpStatus} | ${r.accepted ? "YES" : "NO "}      | ${r.producedImage ? "YES" : "NO"}`);
}

// Now generate with the most promising parameter that was accepted
// Pick strength=0.9 if accepted (high denoising = less source anchoring)
const bestProbe = spike1Results.find(r => r.param === "strength=0.9" && r.accepted && r.producedImage)
  || spike1Results.find(r => r.param === "denoising_strength=0.9" && r.accepted && r.producedImage)
  || spike1Results.find(r => r.param === "mode=style_reference" && r.accepted && r.producedImage);

if (bestProbe) {
  console.log(`\n  Saving image from best probe: ${bestProbe.param}`);
  // Re-run to get the actual image
  const extraKey = bestProbe.param.split("=")[0];
  const extraVal = bestProbe.param.includes("style_reference") || bestProbe.param.includes("style") || bestProbe.param.includes("content") || bestProbe.param.includes("img2img")
    ? bestProbe.param.split("=")[1]
    : parseFloat(bestProbe.param.split("=")[1]);
  const body = {
    prompt: basePrompt,
    original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
    [extraKey]: extraVal,
  };
  const result = await callForge(body, `save ${bestProbe.param}`);
  if (result.hasImage) {
    const path = saveImage(result.parsed.image.b64Json, "spike1_best_param.png");
    console.log(`  Saved: ${path}`);
  }
} else {
  console.log("\n  No parameter variation produced a different result. All silently accepted or all rejected.");
  // Save the baseline (no extra params) for comparison
  const baseResult = await callForge({
    prompt: basePrompt,
    original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
  }, "baseline (no extra params)");
  if (baseResult.hasImage) {
    const path = saveImage(baseResult.parsed.image.b64Json, "spike1_baseline.png");
    console.log(`  Saved baseline: ${path}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPIKE 2: Prompt inversion test
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log("SPIKE 2: Prompt Inversion Test");
console.log("═".repeat(70));

const spike2Prompt = `Generate a llama blowing a dandelion. Match the visual style, line treatment, palette, and composition of the reference image. The character in the reference (Bigfoot) is a STYLE REFERENCE ONLY — do not preserve its silhouette, body, or features. The output character must be unmistakably a llama: long neck, llama head, llama body proportions, no Bigfoot fur, no Bigfoot face. Bust portrait, single ink color (khaki/tan on transparent background), screen-print simulation technique, medium outlines, hand-drawn organic texture, timeless/classic design era.`;

console.log(`\nPrompt: "${spike2Prompt}"`);
console.log(`Source image passed as original_images: YES`);

const spike2Result = await callForge({
  prompt: spike2Prompt,
  original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
}, "spike 2 prompt inversion");

console.log(`\n  HTTP ${spike2Result.status} | Image: ${spike2Result.hasImage}`);
if (spike2Result.hasImage) {
  const path = saveImage(spike2Result.parsed.image.b64Json, "spike2_prompt_inversion.png");
  console.log(`  Saved: ${path}`);
} else {
  console.log(`  Error: ${spike2Result.text.slice(0, 300)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPIKE 3: Pure prompt_only (NO source image)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log("SPIKE 3: Pure Prompt Only (NO source image)");
console.log("═".repeat(70));

const spike3Prompt = `A llama blowing a dandelion with seeds floating away. Bust portrait composition, centered single subject. Screen-print simulation technique with medium outlines. Hand-drawn organic texture with single ink color (khaki/tan). Shirt IS background (transparent). No text. Timeless/classic design era. The llama has a long neck, llama head with pointed ears, gentle closed-eye expression, holding the dandelion stem in one hoof. Style: vintage screen-print, distressed edges, monochrome single-color ink on transparent background.`;

console.log(`\nPrompt: "${spike3Prompt}"`);
console.log(`Source image passed: NO (empty original_images)`);

const spike3Result = await callForge({
  prompt: spike3Prompt,
  original_images: [],
}, "spike 3 pure prompt_only");

console.log(`\n  HTTP ${spike3Result.status} | Image: ${spike3Result.hasImage}`);
if (spike3Result.hasImage) {
  const path = saveImage(spike3Result.parsed.image.b64Json, "spike3_prompt_only.png");
  console.log(`  Saved: ${path}`);
} else {
  console.log(`  Error: ${spike3Result.text.slice(0, 300)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DONE
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log("ALL 3 SPIKES COMPLETE");
console.log("═".repeat(70));
console.log("\nFiles saved:");
console.log("  /home/ubuntu/webdev-static-assets/spike1_*.png");
console.log("  /home/ubuntu/webdev-static-assets/spike2_prompt_inversion.png");
console.log("  /home/ubuntu/webdev-static-assets/spike3_prompt_only.png");
