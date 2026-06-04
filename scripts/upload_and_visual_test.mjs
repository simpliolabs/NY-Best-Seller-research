/**
 * Upload the white-background llama design to S3, then run the visual composite
 * test against all 3 templates with the CORRECT design source.
 */
import sharp from "sharp";
import fs from "fs";
import crypto from "crypto";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

// Upload the white-bg design to S3
async function uploadToS3(filePath, relKey) {
  const baseUrl = FORGE_URL.replace(/\/+$/, "") + "/";
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  const key = lastDot > 0 ? `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}` : `${relKey}_${hash}`;

  const uploadUrl = new URL("v1/storage/upload", baseUrl);
  uploadUrl.searchParams.set("path", key);

  const data = fs.readFileSync(filePath);
  const blob = new Blob([data], { type: "image/png" });
  const form = new FormData();
  form.append("file", blob, key.split("/").pop());

  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${FORGE_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upload failed: ${resp.status} ${text}`);
  }
  const { url } = await resp.json();
  return url;
}

async function detectGarmentBbox(imageUrl) {
  const resp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FORGE_KEY}` },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You are a garment detection system. Given a product mockup photo of a t-shirt, identify the bounding box of the garment's FRONT PRINTABLE AREA (the flat torso region, excluding sleeves, collar, and any background). Return ONLY a JSON object with: x, y, width, height (all 0-1 fractions of image dimensions).`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Detect the garment bounding box. Return only JSON." },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "garment_bbox",
          strict: true,
          schema: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

function resolveZoneToPhoto(printZone, garmentBbox) {
  return {
    x: garmentBbox.x + printZone.x * garmentBbox.width,
    y: garmentBbox.y + printZone.y * garmentBbox.height,
    width: printZone.width * garmentBbox.width,
    height: printZone.height * garmentBbox.height,
  };
}

const TEMPLATES = [
  { name: "Espresso", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/espresso_fac8cc1b.png" },
  { name: "Mustard", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/mustard_fd1dbdfb.png" },
  { name: "Ivory", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/ivory_bd75c54f.png" },
];

const PRINT_ZONE = { x: 0.30, y: 0.18, width: 0.40, height: 0.32 };

async function main() {
  console.log("=== Uploading white-bg design to S3 ===");
  const designUrl = await uploadToS3("/tmp/bug1_white_bg_test.png", "visual-tests/llama_white_bg.png");
  console.log(`Design URL: ${designUrl}`);

  console.log("\n=== Visual Test: Correct design on 3 templates ===");

  // Download design once
  const designResp = await fetch(designUrl);
  const designBuf = Buffer.from(await designResp.arrayBuffer());
  const designMeta = await sharp(designBuf).metadata();
  console.log(`Design: ${designMeta.width}x${designMeta.height}, channels=${designMeta.channels}`);

  // Remove white background from design using flood-fill approach
  // Since the design has white bg, we need to make it transparent first
  const { data: rawData, info } = await sharp(designBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Simple white removal: any pixel with R>240, G>240, B>240 → alpha=0
  for (let i = 0; i < rawData.length; i += 4) {
    const r = rawData[i], g = rawData[i + 1], b = rawData[i + 2];
    if (r > 240 && g > 240 && b > 240) {
      rawData[i + 3] = 0; // Set alpha to 0
    }
  }

  const transparentDesign = await sharp(rawData, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
  console.log("White background removed from design");

  for (const template of TEMPLATES) {
    console.log(`\n--- ${template.name} ---`);

    // Detect garment bbox
    const bbox = await detectGarmentBbox(template.url);
    console.log(`  Garment bbox: x=${bbox.x.toFixed(3)} y=${bbox.y.toFixed(3)} w=${bbox.width.toFixed(3)} h=${bbox.height.toFixed(3)}`);

    // Resolve print zone
    const resolved = resolveZoneToPhoto(PRINT_ZONE, bbox);

    // Download mockup
    const mockupResp = await fetch(template.url);
    const mockupBuf = Buffer.from(await mockupResp.arrayBuffer());
    const mockupMeta = await sharp(mockupBuf).metadata();
    const mockupW = mockupMeta.width;
    const mockupH = mockupMeta.height;

    // Zone in pixels
    const zoneX = Math.round(resolved.x * mockupW);
    const zoneY = Math.round(resolved.y * mockupH);
    const zoneW = Math.round(resolved.width * mockupW);
    const zoneH = Math.round(resolved.height * mockupH);

    // Resize design to fit zone (contain, preserve aspect)
    const scaleW = zoneW / info.width;
    const scaleH = zoneH / info.height;
    const scale = Math.min(scaleW, scaleH);
    const finalW = Math.round(info.width * scale);
    const finalH = Math.round(info.height * scale);

    const resizedDesign = await sharp(transparentDesign)
      .resize(finalW, finalH, { fit: "fill" })
      .toBuffer();

    // Center within zone
    const offsetX = zoneX + Math.round((zoneW - finalW) / 2);
    const offsetY = zoneY + Math.round((zoneH - finalH) / 2);
    console.log(`  Design at: (${offsetX}, ${offsetY}) size ${finalW}x${finalH}`);

    // Composite
    const result = await sharp(mockupBuf)
      .composite([{ input: resizedDesign, left: offsetX, top: offsetY }])
      .png()
      .toBuffer();

    const outPath = `/tmp/visual_final_${template.name.toLowerCase()}.png`;
    await sharp(result).toFile(outPath);
    console.log(`  Output: ${outPath}`);
  }

  console.log("\n=== DONE ===");
  console.log("Design URL (durable): " + designUrl);
}

main().catch(console.error);
