/**
 * Visual Test 3: Portrait (llama) vs Landscape design — same template, same area.
 * Portrait design should fill area HEIGHT, top-anchored, centered horizontally.
 * Landscape design should fill area WIDTH, top-anchored, centered horizontally.
 * Neither should look "weird" or "too small" for a graphic tee.
 */
import sharp from "sharp";
import { createConnection } from "mysql2/promise";

const BUILT_IN_FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const BUILT_IN_FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;

const PRINT_AREA = { x: 0.20, y: 0.10, width: 0.60, height: 0.50 };

async function detectGarmentBbox(imageUrl) {
  const resp = await fetch(`${BUILT_IN_FORGE_API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUILT_IN_FORGE_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You are a garment detection system. Given a product mockup photo, identify the bounding box of the garment's FRONT PRINTABLE AREA (flat torso region, excluding sleeves, collar, background). Return ONLY JSON: {"x": 0-1, "y": 0-1, "width": 0-1, "height": 0-1} as fractions of image dimensions.`,
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

// Portrait design: llama (789×997 after trim)
const PORTRAIT_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663494566154/2UiWq4UmupNv3Rr5UypaGc/test-designs/llama_white_bg_c1f35cc7.png";

function resolveAreaToPhoto(printArea, garmentBbox) {
  return {
    x: garmentBbox.x + printArea.x * garmentBbox.width,
    y: garmentBbox.y + printArea.y * garmentBbox.height,
    width: printArea.width * garmentBbox.width,
    height: printArea.height * garmentBbox.height,
  };
}

async function compositeWithTopAnchor(designBuf, mockupUrl, garmentBbox, label) {
  const mockupResp = await fetch(mockupUrl).then((r) => r.arrayBuffer());
  const mockupBuf = Buffer.from(mockupResp);

  // Trim design to content
  const trimmed = await sharp(designBuf).trim({ threshold: 10 }).toBuffer();
  const designMeta = await sharp(trimmed).metadata();
  const mockupMeta = await sharp(mockupBuf).metadata();

  const mockupW = mockupMeta.width;
  const mockupH = mockupMeta.height;

  console.log(`  [${label}] Design after trim: ${designMeta.width}×${designMeta.height} (${designMeta.width > designMeta.height ? "LANDSCAPE" : "PORTRAIT"})`);

  // Resolve print area to photo coordinates
  const photoZone = resolveAreaToPhoto(PRINT_AREA, garmentBbox);
  const zoneX = Math.round(photoZone.x * mockupW);
  const zoneY = Math.round(photoZone.y * mockupH);
  const zoneW = Math.round(photoZone.width * mockupW);
  const zoneH = Math.round(photoZone.height * mockupH);

  console.log(`  [${label}] Zone in pixels: x=${zoneX} y=${zoneY} w=${zoneW} h=${zoneH}`);

  // Contain-fit
  const scaleW = zoneW / designMeta.width;
  const scaleH = zoneH / designMeta.height;
  const scale = Math.min(scaleW, scaleH);
  const boundAxis = scaleW < scaleH ? "WIDTH" : "HEIGHT";
  const finalW = Math.round(designMeta.width * scale);
  const finalH = Math.round(designMeta.height * scale);

  console.log(`  [${label}] Contain-fit: bound by ${boundAxis} | final: ${finalW}×${finalH} | fills ${(finalW/zoneW*100).toFixed(0)}% of zone width, ${(finalH/zoneH*100).toFixed(0)}% of zone height`);

  const resized = await sharp(trimmed)
    .resize(finalW, finalH, { fit: "fill" })
    .toBuffer();

  // TOP-ANCHOR: center horizontally, top-anchor vertically
  const offsetX = zoneX + Math.round((zoneW - finalW) / 2);
  const offsetY = zoneY; // TOP-ANCHOR

  const result = await sharp(mockupBuf)
    .composite([{ input: resized, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();

  // Garment-relative metrics
  const designRelW = finalW / (garmentBbox.width * mockupW);
  const designRelH = finalH / (garmentBbox.height * mockupH);
  console.log(`  [${label}] Garment-relative: ${(designRelW*100).toFixed(1)}% width × ${(designRelH*100).toFixed(1)}% height`);

  return result;
}

async function main() {
  console.log("=== VISUAL TEST 3: Portrait vs Landscape ===\n");

  // Get first template
  const conn = await createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.execute(
    "SELECT id, imageUrl, colorName, garmentBbox FROM mockup_templates ORDER BY createdAt LIMIT 1"
  );
  await conn.end();
  const template = rows[0];
  let bbox = template.garmentBbox;
  if (bbox && typeof bbox === "string") bbox = JSON.parse(bbox);
  if (!bbox) {
    console.log("  garmentBbox is null — detecting via vision LLM...");
    bbox = await detectGarmentBbox(template.imageUrl);
    console.log("  Detected:", JSON.stringify(bbox));
  }
  console.log(`Template: ${template.colorName} | bbox: x=${bbox.x.toFixed(3)} y=${bbox.y.toFixed(3)} w=${bbox.width.toFixed(3)} h=${bbox.height.toFixed(3)}\n`);

  // --- Portrait design (llama) ---
  console.log("--- PORTRAIT (llama, ~789×997) ---");
  const portraitResp = await fetch(PORTRAIT_URL).then((r) => r.arrayBuffer());
  const portraitBuf = Buffer.from(portraitResp);
  const portraitResult = await compositeWithTopAnchor(portraitBuf, template.imageUrl, bbox, "portrait");
  await sharp(portraitResult).toFile("/tmp/visual_test3_portrait.png");
  console.log("  → Saved: /tmp/visual_test3_portrait.png\n");

  // --- Landscape design (create a synthetic wide graphic: 1200×600 with content) ---
  console.log("--- LANDSCAPE (synthetic wide graphic, 1200×600) ---");
  // Create a landscape design: wide rectangle with some visual content
  const landscapeBuf = await sharp({
    create: {
      width: 1200,
      height: 600,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 255 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 1000,
            height: 450,
            channels: 4,
            background: { r: 40, g: 40, b: 40, alpha: 255 },
          },
        })
          .png()
          .toBuffer(),
        left: 100,
        top: 75,
      },
      // Add some visual interest - a lighter rectangle inside
      {
        input: await sharp({
          create: {
            width: 800,
            height: 200,
            channels: 4,
            background: { r: 180, g: 160, b: 120, alpha: 255 },
          },
        })
          .png()
          .toBuffer(),
        left: 200,
        top: 200,
      },
    ])
    .png()
    .toBuffer();

  const landscapeResult = await compositeWithTopAnchor(landscapeBuf, template.imageUrl, bbox, "landscape");
  await sharp(landscapeResult).toFile("/tmp/visual_test3_landscape.png");
  console.log("  → Saved: /tmp/visual_test3_landscape.png\n");

  console.log("=== EXPECTED BEHAVIOR ===");
  console.log("Portrait (llama): fills area HEIGHT (50% of garment), centered horizontally, top-anchored");
  console.log("Landscape (wide): fills area WIDTH (60% of garment), top-anchored, shorter vertically");
  console.log("Both should look like a real graphic tee print — neither too small nor clipped.");
}

main().catch(console.error);
