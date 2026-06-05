/**
 * Visual Test 1: Aspect-ratio invariance
 * Same design, 3 mockup templates (all tees but different colors/photos).
 * Print should appear in approximately the same garment position in all three.
 *
 * This tests that garment bbox detection + zone resolution produces consistent placement.
 */
import sharp from "sharp";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

// The 3 templates from the DB
const TEMPLATES = [
  { id: "-C9WMvkheydqlYX1fvhtR", name: "Espresso", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/espresso_fac8cc1b.png" },
  { id: "CF91Jsg40ZIYPXI0fvhAt", name: "Mustard", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/mustard_fd1dbdfb.png" },
  { id: "uUah1htYx27vGqfFXZpKo", name: "Ivory", url: "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/mockups/CSrTvm8Y2pQZqzs2x0se-/ivory_bd75c54f.png" },
];

// Use the llama design from the live scan (white background version)
const DESIGN_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/generated/gpt-image-2/live_scan_1780434000499.png";

// Default print zone (garment-relative) — same as updated DEFAULT_PRINT_ZONE
const PRINT_ZONE = { x: 0.30, y: 0.18, width: 0.40, height: 0.32 };

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

async function compositeOnTemplate(template) {
  console.log(`\n--- ${template.name} ---`);

  // 1. Detect garment bbox
  const bbox = await detectGarmentBbox(template.url);
  console.log(`  Garment bbox: x=${bbox.x.toFixed(3)} y=${bbox.y.toFixed(3)} w=${bbox.width.toFixed(3)} h=${bbox.height.toFixed(3)}`);

  // 2. Resolve print zone
  const resolved = resolveZoneToPhoto(PRINT_ZONE, bbox);
  console.log(`  Resolved zone: x=${resolved.x.toFixed(3)} y=${resolved.y.toFixed(3)} w=${resolved.width.toFixed(3)} h=${resolved.height.toFixed(3)}`);

  // 3. Download mockup and design
  const [mockupResp, designResp] = await Promise.all([
    fetch(template.url),
    fetch(DESIGN_URL),
  ]);
  const mockupBuf = Buffer.from(await mockupResp.arrayBuffer());
  const designBuf = Buffer.from(await designResp.arrayBuffer());

  // 4. Get mockup dimensions
  const mockupMeta = await sharp(mockupBuf).metadata();
  const mockupW = mockupMeta.width;
  const mockupH = mockupMeta.height;
  console.log(`  Mockup: ${mockupW}x${mockupH}`);

  // 5. Calculate zone in pixels
  const zoneX = Math.round(resolved.x * mockupW);
  const zoneY = Math.round(resolved.y * mockupH);
  const zoneW = Math.round(resolved.width * mockupW);
  const zoneH = Math.round(resolved.height * mockupH);
  console.log(`  Zone px: x=${zoneX} y=${zoneY} w=${zoneW} h=${zoneH}`);

  // 6. Resize design to fit zone (contain)
  const designMeta = await sharp(designBuf).metadata();
  const scaleW = zoneW / designMeta.width;
  const scaleH = zoneH / designMeta.height;
  const scale = Math.min(scaleW, scaleH);
  const finalW = Math.round(designMeta.width * scale);
  const finalH = Math.round(designMeta.height * scale);

  const resizedDesign = await sharp(designBuf)
    .resize(finalW, finalH, { fit: "fill" })
    .toBuffer();

  // 7. Center within zone
  const offsetX = zoneX + Math.round((zoneW - finalW) / 2);
  const offsetY = zoneY + Math.round((zoneH - finalH) / 2);
  console.log(`  Design placed at: (${offsetX}, ${offsetY}) size ${finalW}x${finalH}`);

  // 8. Composite
  const result = await sharp(mockupBuf)
    .composite([{ input: resizedDesign, left: offsetX, top: offsetY }])
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const outPath = `/tmp/visual_test_${template.name.toLowerCase()}.webp`;
  await sharp(result).toFile(outPath);
  console.log(`  Output: ${outPath}`);

  // Return placement metrics for comparison
  return {
    name: template.name,
    garmentBbox: bbox,
    // Design center as fraction of garment
    designCenterRelGarment: {
      x: (offsetX + finalW / 2 - bbox.x * mockupW) / (bbox.width * mockupW),
      y: (offsetY + finalH / 2 - bbox.y * mockupH) / (bbox.height * mockupH),
    },
    designSizeRelGarment: {
      w: finalW / (bbox.width * mockupW),
      h: finalH / (bbox.height * mockupH),
    },
  };
}

async function main() {
  console.log("=== Visual Test 1: Aspect-Ratio Invariance ===");
  console.log(`Design: ${DESIGN_URL}`);
  console.log(`Print zone (garment-relative): ${JSON.stringify(PRINT_ZONE)}`);

  const results = [];
  for (const template of TEMPLATES) {
    const r = await compositeOnTemplate(template);
    results.push(r);
  }

  // Compare: all designs should be at approximately the same garment-relative position
  console.log("\n=== COMPARISON ===");
  console.log("Template       | Center X (garment) | Center Y (garment) | Size W (garment) | Size H (garment)");
  console.log("---------------|--------------------|--------------------|------------------|------------------");
  for (const r of results) {
    console.log(
      `${r.name.padEnd(15)}| ${r.designCenterRelGarment.x.toFixed(3).padEnd(19)}| ${r.designCenterRelGarment.y.toFixed(3).padEnd(19)}| ${r.designSizeRelGarment.w.toFixed(3).padEnd(17)}| ${r.designSizeRelGarment.h.toFixed(3)}`
    );
  }

  // Acceptance: center positions should be within 5% of each other
  const centerXs = results.map(r => r.designCenterRelGarment.x);
  const centerYs = results.map(r => r.designCenterRelGarment.y);
  const maxDiffX = Math.max(...centerXs) - Math.min(...centerXs);
  const maxDiffY = Math.max(...centerYs) - Math.min(...centerYs);

  console.log(`\nMax center X spread: ${(maxDiffX * 100).toFixed(1)}% (pass if < 10%)`);
  console.log(`Max center Y spread: ${(maxDiffY * 100).toFixed(1)}% (pass if < 10%)`);
  console.log(`\nRESULT: ${maxDiffX < 0.10 && maxDiffY < 0.10 ? "✅ PASS" : "❌ FAIL"}`);
}

main().catch(console.error);
