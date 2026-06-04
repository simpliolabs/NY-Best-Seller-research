import { describe, it, expect } from "vitest";
import { resolveZoneToPhoto, type GarmentBbox } from "./garmentDetector";

describe("resolveZoneToPhoto", () => {
  it("converts garment-relative zone to photo-relative coordinates", () => {
    // Garment occupies the center 60% width, 70% height of the photo
    const garmentBbox: GarmentBbox = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
    // Print zone: centered within garment, 50% of garment width, 40% of garment height
    const printZone = { x: 0.25, y: 0.15, width: 0.5, height: 0.4 };

    const result = resolveZoneToPhoto(printZone, garmentBbox);

    // x = 0.2 + 0.25 * 0.6 = 0.35
    expect(result.x).toBeCloseTo(0.35, 5);
    // y = 0.1 + 0.15 * 0.7 = 0.205
    expect(result.y).toBeCloseTo(0.205, 5);
    // width = 0.5 * 0.6 = 0.3
    expect(result.width).toBeCloseTo(0.3, 5);
    // height = 0.4 * 0.7 = 0.28
    expect(result.height).toBeCloseTo(0.28, 5);
  });

  it("identity: full garment zone maps to garment bbox", () => {
    const garmentBbox: GarmentBbox = { x: 0.15, y: 0.08, width: 0.7, height: 0.8 };
    const fullZone = { x: 0, y: 0, width: 1, height: 1 };

    const result = resolveZoneToPhoto(fullZone, garmentBbox);

    expect(result.x).toBeCloseTo(garmentBbox.x, 5);
    expect(result.y).toBeCloseTo(garmentBbox.y, 5);
    expect(result.width).toBeCloseTo(garmentBbox.width, 5);
    expect(result.height).toBeCloseTo(garmentBbox.height, 5);
  });

  it("aspect-ratio invariance: same garment-relative zone produces same garment-relative position regardless of garment bbox size", () => {
    // Same print zone definition
    const printZone = { x: 0.15, y: 0.10, width: 0.70, height: 0.45 };

    // Two different garment bboxes (different photos/zoom levels)
    const tightCrop: GarmentBbox = { x: 0.05, y: 0.02, width: 0.9, height: 0.96 };
    const looseCrop: GarmentBbox = { x: 0.25, y: 0.15, width: 0.5, height: 0.6 };

    const resultTight = resolveZoneToPhoto(printZone, tightCrop);
    const resultLoose = resolveZoneToPhoto(printZone, looseCrop);

    // The print zone occupies the same fraction of the garment in both cases
    // Verify: zone center relative to garment center is the same
    const garmentCenterTight = { x: tightCrop.x + tightCrop.width / 2, y: tightCrop.y + tightCrop.height / 2 };
    const zoneCenterTight = { x: resultTight.x + resultTight.width / 2, y: resultTight.y + resultTight.height / 2 };
    const relCenterTight = {
      x: (zoneCenterTight.x - garmentCenterTight.x) / tightCrop.width,
      y: (zoneCenterTight.y - garmentCenterTight.y) / tightCrop.height,
    };

    const garmentCenterLoose = { x: looseCrop.x + looseCrop.width / 2, y: looseCrop.y + looseCrop.height / 2 };
    const zoneCenterLoose = { x: resultLoose.x + resultLoose.width / 2, y: resultLoose.y + resultLoose.height / 2 };
    const relCenterLoose = {
      x: (zoneCenterLoose.x - garmentCenterLoose.x) / looseCrop.width,
      y: (zoneCenterLoose.y - garmentCenterLoose.y) / looseCrop.height,
    };

    // Relative positions should be identical
    expect(relCenterTight.x).toBeCloseTo(relCenterLoose.x, 5);
    expect(relCenterTight.y).toBeCloseTo(relCenterLoose.y, 5);
  });

  it("inverse roundtrip: photo-relative → garment-relative → photo-relative", () => {
    const garmentBbox: GarmentBbox = { x: 0.18, y: 0.12, width: 0.64, height: 0.76 };
    // Original photo-relative zone
    const originalPhotoZone = { x: 0.30, y: 0.20, width: 0.40, height: 0.35 };

    // Convert to garment-relative (inverse of resolveZoneToPhoto)
    const garmentRelative = {
      x: (originalPhotoZone.x - garmentBbox.x) / garmentBbox.width,
      y: (originalPhotoZone.y - garmentBbox.y) / garmentBbox.height,
      width: originalPhotoZone.width / garmentBbox.width,
      height: originalPhotoZone.height / garmentBbox.height,
    };

    // Convert back to photo-relative
    const roundtripped = resolveZoneToPhoto(garmentRelative, garmentBbox);

    expect(roundtripped.x).toBeCloseTo(originalPhotoZone.x, 5);
    expect(roundtripped.y).toBeCloseTo(originalPhotoZone.y, 5);
    expect(roundtripped.width).toBeCloseTo(originalPhotoZone.width, 5);
    expect(roundtripped.height).toBeCloseTo(originalPhotoZone.height, 5);
  });
});
