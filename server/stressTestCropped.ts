/**
 * Stress test: crop artwork from shirt photo, then run edit with minimal prompt.
 * Tests whether extracting the artwork before editing prevents shirt contamination.
 */
import sharp from "sharp";
import fs from "fs";
import path from "path";

const RESULTS_DIR = "/home/ubuntu/prompt-stress-test/results-cropped";

async function run() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  // Download source image (Dalmatian shirt photo)
  const sourceUrl = "https://i.etsystatic.com/56971892/r/il/8a9e41/8080154511/il_fullxfull.8080154511_lojg.jpg";
  const resp = await fetch(sourceUrl);
  const srcBuf = Buffer.from(await resp.arrayBuffer());

  // The artwork is roughly in the center of the shirt.
  // Image is 2000x2000. The artwork area is approximately:
  // x: 350-1200, y: 150-1400 (the rectangular print area)
  // Let's crop to just the artwork
  const cropped = await sharp(srcBuf)
    .extract({ left: 350, top: 150, width: 850, height: 1250 })
    .png()
    .toBuffer();

  // Save the cropped source for reference
  fs.writeFileSync(path.join(RESULTS_DIR, "cropped_source.png"), cropped);
  console.log("Saved cropped source");

  // Now run the edit with the cropped artwork (no shirt)
  const prompt = "Replace the Dalmatians with T-Rexes.";
  console.log(`Running edit with cropped source. Prompt: "${prompt}"`);

  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "high");
  formData.append("background", "transparent");
  const blob = new Blob([new Uint8Array(cropped)], { type: "image/png" });
  formData.append("image[]", blob, "artwork.png");

  const apiResp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });

  if (!apiResp.ok) {
    const err = await apiResp.text();
    throw new Error(`API error ${apiResp.status}: ${err.substring(0, 300)}`);
  }

  const data = await apiResp.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("No image returned");

  let resultBuf: Buffer;
  if (item.b64_json) {
    resultBuf = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dl = await fetch(item.url);
    resultBuf = Buffer.from(await dl.arrayBuffer());
  } else {
    throw new Error("No b64_json or url in response");
  }

  fs.writeFileSync(path.join(RESULTS_DIR, "cropped_edit_result.png"), resultBuf);
  console.log("✅ Saved cropped edit result");
}

run().catch(e => { console.error(e); process.exit(1); });
