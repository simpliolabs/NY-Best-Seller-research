/**
 * Stress test: 3 prompt variants for gpt-image-1 /images/edits
 * Source: Bigfoot booping a cat (silhouette, moon, trees)
 * Goal: Replace Bigfoot with T-Rex, replace cat with Llama
 *
 * Run: cd /home/ubuntu/nyt-design-bot && npx tsx server/stressTestEditPrompt.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";

async function runStressTest() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY not found"); process.exit(1); }
  console.log(`API key loaded (length: ${apiKey.length})`);

  const sourceJpg = "/home/ubuntu/prompt-stress-test/source_bigfoot_cat.jpg";
  const outputDir = "/home/ubuntu/prompt-stress-test/results";
  mkdirSync(outputDir, { recursive: true });

  // Convert source to PNG (gpt-image-1 requires PNG)
  const sourcePng = "/home/ubuntu/prompt-stress-test/source_bigfoot_cat.png";
  const pngBuf = await sharp(readFileSync(sourceJpg)).png().toBuffer();
  writeFileSync(sourcePng, pngBuf);
  console.log(`Source PNG: ${pngBuf.length} bytes`);

  // 3 prompt variants — testing from minimal to explicit
  const variants = [
    {
      name: "v1_minimal",
      prompt: "Replace the Bigfoot with a T-Rex. Replace the cat with a Llama.",
    },
    {
      name: "v2_explicit_preserve",
      prompt: "Replace the Bigfoot with a T-Rex and the cat with a Llama. Same silhouette style, same moon, same trees, same BOOP text, same pose.",
    },
    {
      name: "v3_surgical",
      prompt: "Swap the Bigfoot character for a T-Rex dinosaur. Swap the small cat for a Llama. Preserve the black silhouette art style, circular moon background, forest trees, birds, and BOOP text exactly as they are.",
    },
  ];

  async function callEditAPI(prompt: string, imagePath: string): Promise<Buffer> {
    const imgPng = await sharp(readFileSync(imagePath)).png().toBuffer();
    const formData = new FormData();
    formData.append("model", "gpt-image-1");
    formData.append("prompt", prompt);
    formData.append("size", "1024x1024");
    formData.append("quality", "high");
    // NO background:transparent — live pipeline strips bg via cropToContent after the edit
    const blob = new Blob([new Uint8Array(imgPng)], { type: "image/png" });
    formData.append("image[]", blob, "source.png");

    const resp = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API ${resp.status}: ${err.slice(0, 300)}`);
    }

    const data = await resp.json() as { data: Array<{ b64_json?: string; url?: string }> };
    const item = data.data[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
    if (item?.url) {
      const dlResp = await fetch(item.url);
      return Buffer.from(await dlResp.arrayBuffer());
    }
    throw new Error("No image in response");
  }

  const results: Array<{ name: string; prompt: string; status: string; path?: string; error?: string }> = [];

  for (const v of variants) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing: ${v.name}`);
    console.log(`Prompt: ${v.prompt}`);
    console.log("Calling API...");
    try {
      const imgBuf = await callEditAPI(v.prompt, sourcePng);
      const outPath = join(outputDir, `${v.name}.png`);
      writeFileSync(outPath, imgBuf);
      console.log(`✅ Saved: ${outPath} (${imgBuf.length} bytes)`);
      results.push({ name: v.name, prompt: v.prompt, status: "ok", path: outPath });
    } catch (e: any) {
      console.error(`❌ Failed: ${e.message}`);
      results.push({ name: v.name, prompt: v.prompt, status: "error", error: e.message });
    }
  }

  console.log("\n\n=== RESULTS SUMMARY ===");
  for (const r of results) {
    console.log(`${r.name}: ${r.status}`);
    if (r.status === "ok") console.log(`  → ${r.path}`);
    else console.log(`  → ${r.error}`);
  }

  writeFileSync(join(outputDir, "results.json"), JSON.stringify(results, null, 2));
  console.log("\nDone.");
}

runStressTest().catch(console.error);
