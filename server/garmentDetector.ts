/**
 * Garment Detector — coordinate helper (DETECTION REMOVED 2026-06-09).
 *
 * The vision-LLM garment-bbox detection (detectGarmentBbox / getGarmentBbox) was deleted:
 * LLMs locate bounding boxes poorly (research: often wrong quadrant, ~13% IoU), so placement
 * now uses HUMAN-CALIBRATED per-template print areas (resolvePrintZone in mockupCompositor.ts).
 * The mockup_templates `garmentBbox` column is repurposed to store those per-template print
 * boxes; removing the detector also removes the ONLY writer that would clobber them.
 *
 * resolveZoneToPhoto + the GarmentBbox type are KEPT (pure, DB-free, still unit-tested) for any
 * garment-relative → photo conversion callers.
 */

export interface GarmentBbox {
  x: number;      // left edge, 0-1 (fraction of photo width)
  y: number;      // top edge, 0-1 (fraction of photo height)
  width: number;  // 0-1
  height: number; // 0-1
}

/**
 * Resolve a print zone (fractions of garment bbox) to absolute fractions of the photo.
 *
 * printZone: fractions relative to the garment bbox (e.g., x=0.10 means 10% from left of shirt)
 * garmentBbox: fractions relative to the photo
 * returns: fractions relative to the photo
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
