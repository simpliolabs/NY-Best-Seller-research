/**
 * Image generation helper using internal ImageService
 *
 * Example usage:
 *   const { url: imageUrl } = await generateImage({
 *     prompt: "A serene landscape with mountains"
 *   });
 *
 * For editing:
 *   const { url: imageUrl } = await generateImage({
 *     prompt: "Add a rainbow to this landscape",
 *     originalImages: [{
 *       url: "https://example.com/original.jpg",
 *       mimeType: "image/jpeg"
 *     }]
 *   });
 */
import { storagePut } from "server/storage";
import { ENV } from "./env";

export type GenerateImageOptions = {
  prompt: string;
  originalImages?: Array<{
    url?: string;
    b64Json?: string;
    mimeType?: string;
  }>;
  signal?: AbortSignal;
};

export type GenerateImageResponse = {
  url?: string;
};

// ─── gpt-image-2 (SCAN PIPELINE ONLY) ────────────────────────────────────────
// These two functions are used ONLY by server/pipeline.ts (the niche scan). The Niche Hunter has its
// OWN image path (callGptImage2Edit + patternProductionProcessor) and uses generateImage (Forge)
// below — so changes here NEVER affect the Niche Hunter (PO constraint 2026-06-13).

/** Decode a gpt-image-2 response (b64 or url) and store to S3. */
async function storeGptImage2Response(resp: Response): Promise<GenerateImageResponse> {
  const data = (await resp.json()) as { data: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("gpt-image-2 returned no image data");
  let buffer: Buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const dl = await fetch(item.url);
    buffer = Buffer.from(await dl.arrayBuffer());
  } else {
    throw new Error("gpt-image-2 response has neither b64_json nor url");
  }
  const { url } = await storagePut(`generated/gpt-image-2/${Date.now()}.png`, buffer, "image/png");
  return { url };
}

/**
 * Text-to-image via OpenAI gpt-image-2 (premium typography/realism vs the Forge ImageService).
 * SCAN ONLY — the Niche Hunter uses its own callGptImage2Edit + generateImage (Forge), so changes
 * here never affect it. Fail-loud so the caller can fall back to Forge.
 *
 * (The `background:"transparent"` best-effort was removed 2026-06-13: the /generations endpoint
 * ALWAYS rejects it — every image wasted a failing attempt — and deferring background-removal out
 * of the scan made it pointless. Designs render opaque; bg removal runs on-demand for mockups.)
 */
export async function generateGptImage2(
  prompt: string,
  signal?: AbortSignal,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024", // PO 2026-06-16: per-concept canvas
): Promise<GenerateImageResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured — cannot call gpt-image-2");
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt, size, quality: "medium", n: 1 }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`gpt-image-2 generations error (${resp.status}): ${errText.substring(0, 300)}`);
  }
  return storeGptImage2Response(resp);
}

/**
 * Image-to-image EDIT via gpt-image-2 /images/edits — anchors output to a real in-niche bestseller
 * image while the prompt expresses the new concept. SCAN ONLY. Fail-loud so the caller can fall back.
 */
export async function generateGptImage2Edit(prompt: string, sourceImageUrl: string, signal?: AbortSignal): Promise<GenerateImageResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured — cannot call gpt-image-2");
  const imgResp = await fetch(sourceImageUrl, { signal });
  if (!imgResp.ok) throw new Error(`Failed to download source image: ${imgResp.status}`);
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());
  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "medium");
  formData.append("image[]", new Blob([imgBuf], { type: "image/jpeg" }), "source.jpg");
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`gpt-image-2 edit error (${resp.status}): ${errText.substring(0, 300)}`);
  }
  return storeGptImage2Response(resp);
}

export async function generateImage(
  options: GenerateImageOptions
): Promise<GenerateImageResponse> {
  if (!ENV.forgeApiUrl) {
    throw new Error("BUILT_IN_FORGE_API_URL is not configured");
  }
  if (!ENV.forgeApiKey) {
    throw new Error("BUILT_IN_FORGE_API_KEY is not configured");
  }

  // Build the full URL by appending the service path to the base URL
  const baseUrl = ENV.forgeApiUrl.endsWith("/")
    ? ENV.forgeApiUrl
    : `${ENV.forgeApiUrl}/`;
  const fullUrl = new URL(
    "images.v1.ImageService/GenerateImage",
    baseUrl
  ).toString();

  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${ENV.forgeApiKey}`,
    },
    body: JSON.stringify({
      prompt: options.prompt,
      original_images: options.originalImages || [],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Image generation request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
    );
  }

  const result = (await response.json()) as {
    image: {
      b64Json: string;
      mimeType: string;
    };
  };
  const base64Data = result.image.b64Json;
  const buffer = Buffer.from(base64Data, "base64");

  // Save to S3
  const { url } = await storagePut(
    `generated/${Date.now()}.png`,
    buffer,
    result.image.mimeType
  );
  return {
    url,
  };
}
