/**
 * Probe script: test whether Forge exposes mask/inpaint parameters.
 * Tests three things:
 *   1. Does GenerateImage accept a mask_image field without error?
 *   2. Does an InpaintImage endpoint exist?
 *   3. Does an EditImage endpoint exist?
 *
 * Run: node scripts/probe_forge_inpaint.mjs
 */
import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

if (!FORGE_URL || !FORGE_KEY) {
  console.error("Missing BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY");
  process.exit(1);
}

const baseUrl = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;

// 1x1 white PNG as base64 — minimal valid mask
const WHITE_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

// Known source image for realistic test
const SOURCE_IMAGE_URL =
  "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";

const tests = [
  {
    label: "GenerateImage — with mask_image field (does it accept or reject?)",
    endpoint: "images.v1.ImageService/GenerateImage",
    body: {
      prompt: "test probe",
      original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
      mask_image: { b64Json: WHITE_1PX, mimeType: "image/png" },
    },
  },
  {
    label: "GenerateImage — with mask field (alternate name)",
    endpoint: "images.v1.ImageService/GenerateImage",
    body: {
      prompt: "test probe",
      original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
      mask: WHITE_1PX,
    },
  },
  {
    label: "InpaintImage — does this endpoint exist?",
    endpoint: "images.v1.ImageService/InpaintImage",
    body: {
      prompt: "test probe",
      original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
      mask_image: { b64Json: WHITE_1PX, mimeType: "image/png" },
    },
  },
  {
    label: "EditImage — does this endpoint exist?",
    endpoint: "images.v1.ImageService/EditImage",
    body: {
      prompt: "test probe",
      original_images: [{ url: SOURCE_IMAGE_URL, mimeType: "image/jpeg" }],
      mask_image: { b64Json: WHITE_1PX, mimeType: "image/png" },
    },
  },
];

console.log(`\nForge base URL: ${baseUrl}`);
console.log(`${"=".repeat(60)}`);

for (const test of tests) {
  const url = new URL(test.endpoint, baseUrl).toString();
  console.log(`\n[TEST] ${test.label}`);
  console.log(`  URL: ${url}`);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "connect-protocol-version": "1",
        authorization: `Bearer ${FORGE_KEY}`,
      },
      body: JSON.stringify(test.body),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    console.log(`  HTTP: ${r.status} ${r.statusText}`);
    // Truncate body but show enough to understand the response
    const preview = body.slice(0, 500);
    console.log(`  Body: ${preview}`);
    // Key interpretation
    if (r.status === 404 || body.includes("not found") || body.includes("unknown service")) {
      console.log(`  → VERDICT: endpoint does NOT exist`);
    } else if (r.status === 400 && (body.includes("unknown field") || body.includes("mask"))) {
      console.log(`  → VERDICT: endpoint exists but mask field is REJECTED (unknown field)`);
    } else if (r.status === 400 && body.includes("prompt")) {
      console.log(`  → VERDICT: endpoint exists, mask field ACCEPTED (error is about prompt/image, not mask)`);
    } else if (r.status === 200) {
      console.log(`  → VERDICT: SUCCESS — endpoint exists and accepted the request`);
    } else {
      console.log(`  → VERDICT: ambiguous — needs manual inspection`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    console.log(`  → VERDICT: network error or timeout`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log("Probe complete.");
