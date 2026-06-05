/**
 * Visual Test 2: Photo-zoom invariance
 * Same design, same template (Espresso), but simulate different camera zoom
 * by cropping the mockup photo to different extents.
 *
 * If the system is correct, the design should appear in the same position
 * on the garment regardless of how zoomed-in the photo is.
 *
 * We simulate 3 zoom levels:
 * - Original (full photo)
 * - Medium crop (center 80%)
 * - Tight crop (center 60%)
 */
import sharp from "sharp";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const TEMPLATE_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/espresso_fac8cc1b.png";
const DESIGN_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/generated/gpt-image-2/live_scan_1780434000499.png";
const PRINT_ZONE = { x: 0.30, y: 0.18, width: 0.40, height: 0.32 };

async function detectGarmentBbox(imageBuf) {
  // Upload to temp URL or use base64
  const base64 = imageBuf.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

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
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
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

async function testZoomLevel(mockupBuf, cropFraction, label) {
  console.log(`\n--- ${label} (crop ${Math.round(cropFraction * 100)}%) ---`);

  const meta = await sharp(mockupBuf).metadata();
  const origW = meta.width;
  const origH = meta.height;

  // Crop to center
  const cropW = Math.round(origW * cropFraction);
  const cropH = Math.round(origH * cropFraction);
  const cropX = Math.round((origW - cropW) / 2);
  const cropY = Math.round((origH - cropH) / 2);

  const croppedBuf = await sharp(mockupBuf)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .toBuffer();

  console.log(`  Cropped: ${cropW}x${cropH} from (${cropX},${cropY})`);

  // Detect garment bbox on the cropped image
  const bbox = await detectGarmentBbox(croppedBuf);
  console.log(`  Garment bbox: x=${bbox.x.toFixed(3)} y=${bbox.y.toFixed(3)} w=${bbox.width.toFixed(3)} h=${bbox.height.toFixed(3)}`);

  // Resolve print zone
  const resolved = resolveZoneToPhoto(PRINT_ZONE, bbox);
  console.log(`  Resolved zone: x=${resolved.x.toFixed(3)} y=${resolved.y.toFixed(3)} w=${resolved.width.toFixed(3)} h=${resolved.height.toFixed(3)}`);

  // Composite
  const designResp = await fetch(DESIGN_URL);
  const designBuf = Buffer.from(await designResp.arrayBuffer());

  const zoneX = Math.round(resolved.x * cropW);
  const zoneY = Math.round(resolved.y * cropH);
  const zoneW = Math.round(resolved.width * cropW);
  const zoneH = Math.round(resolved.height * cropH);

  const designMeta = await sharp(designBuf).metadata();
  const scale = Math.min(zoneW / designMeta.width, zoneH / designMeta.height);
  const finalW = Math.round(designMeta.width * scale);
  const finalH = Math.round(designMeta.height * scale);

  const resizedDesign = await sharp(designBuf)
    .resize(finalW, finalH, { fit: "fill" })
    .toBuffer();

  const offsetX = zoneX + Math.round((zoneW - finalW) / 2);
  const offsetY = zoneY + Math.round((zoneH - finalH) / 2);

  const result = await sharp(croppedBuf)
    .composite([{ input: resizedDesign, left: offsetX, top: offsetY }])
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const outPath = `/tmp/visual_test_zoom_${label.toLowerCase().replace(/\s/g, "_")}.webp`;
  await sharp(result).toFile(outPath);
  console.log(`  Output: ${outPath}`);

  // Return: design center as fraction of garment bbox (should be same across zoom levels)
  return {
    label,
    designCenterRelGarment: {
      x: (offsetX + finalW / 2 - bbox.x * cropW) / (bbox.width * cropW),
      y: (offsetY + finalH / 2 - bbox.y * cropH) / (bbox.height * cropH),
    },
    designSizeRelGarment: {
      w: finalW / (bbox.width * cropW),
      h: finalH / (bbox.height * cropH),
    },
  };
}

async function main() {
  console.log("=== Visual Test 2: Photo-Zoom Invariance ===");

  const mockupResp = await fetch(TEMPLATE_URL);
  const mockupBuf = Buffer.from(await mockupResp.arrayBuffer());

  const results = [];
  results.push(await testZoomLevel(mockupBuf, 1.0, "Full photo"));
  results.push(await testZoomLevel(mockupBuf, 0.8, "Medium crop"));
  results.push(await testZoomLevel(mockupBuf, 0.65, "Tight crop"));

  console.log("\n=== COMPARISON ===");
  console.log("Zoom Level     | Center X (garment) | Center Y (garment) | Size W (garment) | Size H (garment)");
  console.log("---------------|--------------------|--------------------|------------------|------------------");
  for (const r of results) {
    console.log(
      `${r.label.padEnd(15)}| ${r.designCenterRelGarment.x.toFixed(3).padEnd(19)}| ${r.designCenterRelGarment.y.toFixed(3).padEnd(19)}| ${r.designSizeRelGarment.w.toFixed(3).padEnd(17)}| ${r.designSizeRelGarment.h.toFixed(3)}`
    );
  }

  const centerXs = results.map(r => r.designCenterRelGarment.x);
  const centerYs = results.map(r => r.designCenterRelGarment.y);
  const maxDiffX = Math.max(...centerXs) - Math.min(...centerXs);
  const maxDiffY = Math.max(...centerYs) - Math.min(...centerYs);

  console.log(`\nMax center X spread: ${(maxDiffX * 100).toFixed(1)}% (pass if < 10%)`);
  console.log(`Max center Y spread: ${(maxDiffY * 100).toFixed(1)}% (pass if < 10%)`);
  console.log(`\nRESULT: ${maxDiffX < 0.10 && maxDiffY < 0.10 ? "✅ PASS" : "❌ FAIL"}`);
}

main().catch(console.error);
