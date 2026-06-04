/**
 * Garment Detector — Vision-based garment bounding box detection.
 * Uses the LLM vision endpoint to find the shirt/garment in a mockup photo.
 * Result is cached per template in the `garmentBbox` column.
 *
 * Approach (B): No manual calibration. Vision finds the shirt bbox once per template.
 * Print zones are then expressed as fractions of the shirt bbox, not the photo.
 */
import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { mockupTemplates } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface GarmentBbox {
  x: number;      // left edge, 0-1 (fraction of photo width)
  y: number;      // top edge, 0-1 (fraction of photo height)
  width: number;  // 0-1
  height: number; // 0-1
}

/**
 * Detect the garment bounding box in a mockup template image using vision LLM.
 * Returns normalized coordinates (0-1) relative to the photo dimensions.
 */
export async function detectGarmentBbox(imageUrl: string): Promise<GarmentBbox> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a garment detection system. Given a product mockup photo of a t-shirt, tank top, hoodie, or similar garment, identify the bounding box of the garment's FRONT PRINTABLE AREA (the flat torso region, excluding sleeves, collar, and any background).

Return ONLY a JSON object with these fields (all values as decimals 0-1 representing fractions of the image dimensions):
- x: left edge of the garment torso
- y: top edge of the garment (below collar/neckline)
- width: width of the garment torso
- height: height from neckline to hem

Be precise. The bounding box should tightly contain the garment's front panel where a print would be applied.`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Detect the garment bounding box in this mockup photo. Return only the JSON object.",
          },
          {
            type: "image_url",
            image_url: { url: imageUrl, detail: "low" },
          },
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
            x: { type: "number", description: "Left edge as fraction 0-1 of image width" },
            y: { type: "number", description: "Top edge as fraction 0-1 of image height" },
            width: { type: "number", description: "Width as fraction 0-1 of image width" },
            height: { type: "number", description: "Height as fraction 0-1 of image height" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
      },
    },
  });

  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error("Vision LLM returned empty response for garment detection");
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);

  const bbox: GarmentBbox = JSON.parse(content);

  // Sanity checks
  if (bbox.x < 0 || bbox.x > 1 || bbox.y < 0 || bbox.y > 1 ||
      bbox.width < 0.1 || bbox.width > 1 || bbox.height < 0.1 || bbox.height > 1 ||
      bbox.x + bbox.width > 1.05 || bbox.y + bbox.height > 1.05) {
    throw new Error(`Garment bbox out of bounds: ${JSON.stringify(bbox)}`);
  }

  // Clamp to valid range
  bbox.x = Math.max(0, Math.min(1, bbox.x));
  bbox.y = Math.max(0, Math.min(1, bbox.y));
  bbox.width = Math.min(1 - bbox.x, bbox.width);
  bbox.height = Math.min(1 - bbox.y, bbox.height);

  return bbox;
}

/**
 * Get the garment bbox for a template, using cached value if available.
 * If not cached, detects it and saves to the database.
 */
export async function getGarmentBbox(templateId: string, imageUrl: string): Promise<GarmentBbox> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check cache first
  const [template] = await db
    .select({ garmentBbox: mockupTemplates.garmentBbox })
    .from(mockupTemplates)
    .where(eq(mockupTemplates.id, templateId))
    .limit(1);

  if (template?.garmentBbox) {
    return template.garmentBbox as GarmentBbox;
  }

  // Detect and cache
  console.log(`[GarmentDetector] Detecting bbox for template ${templateId}...`);
  const bbox = await detectGarmentBbox(imageUrl);
  console.log(`[GarmentDetector] Detected: x=${bbox.x.toFixed(3)} y=${bbox.y.toFixed(3)} w=${bbox.width.toFixed(3)} h=${bbox.height.toFixed(3)}`);

  // Save to DB (db is guaranteed non-null from check above)
  await db!
    .update(mockupTemplates)
    .set({ garmentBbox: bbox as any })
    .where(eq(mockupTemplates.id, templateId));

  return bbox;
}

/**
 * Resolve a print zone (fractions of garment bbox) to absolute fractions of the photo.
 * This is the key transformation that makes print zones portable across templates.
 *
 * printZone: fractions relative to the garment bbox (e.g., x=0.10 means 10% from left of shirt)
 * garmentBbox: fractions relative to the photo (detected by vision)
 * returns: fractions relative to the photo (what the compositor needs)
 */
export function resolveZoneToPhoto(
  printZone: { x: number; y: number; width: number; height: number },
  garmentBbox: GarmentBbox
): { x: number; y: number; width: number; height: number } {
  return {
    x: garmentBbox.x + printZone.x * garmentBbox.width,
    y: garmentBbox.y + printZone.y * garmentBbox.height,
    width: printZone.width * garmentBbox.width,
    height: printZone.height * garmentBbox.height,
  };
}
