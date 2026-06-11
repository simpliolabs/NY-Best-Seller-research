/**
 * TEMPORARY image-model bake-off harness (PO 2026-06-11) — REMOVE once per-job
 * model routing is decided.
 *
 * Why a server endpoint: the candidate models need OPENAI_API_KEY / FAL_KEY,
 * which live only in the deployment env (PO is non-technical; no local .env).
 * This lets the architect drive "same input, N models" comparisons from an
 * authenticated browser session and pixel-verify the outputs locally.
 *
 * One model call per request (Cloudflare ~100s edge ceiling — no fan-out here;
 * the caller orchestrates). Auth-protected like every other procedure.
 */
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { callImageEdit } from "./patternProductionProcessor";
import { storagePut } from "./storage";

/** Generic fal queue call: submit → poll (≤85s) → return fal's hosted output URL. */
async function callFalModel(model: string, body: Record<string, unknown>): Promise<{ url: string; raw: string }> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not configured");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };

  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!submit.ok) {
    throw new Error(`fal submit error (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const { status_url, response_url } = (await submit.json()) as { status_url: string; response_url: string };

  let completed = false;
  for (let i = 0; i < 28; i++) { // 28 × 3s ≈ 84s, under the edge timeout
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(status_url, { headers })).json()) as { status?: string; error?: unknown };
    if (st.status === "COMPLETED") { completed = true; break; }
    if (st.status === "FAILED" || st.error) throw new Error(`fal failed: ${JSON.stringify(st).slice(0, 300)}`);
  }
  if (!completed) throw new Error("fal timed out (~85s cap)");

  const out = (await (await fetch(response_url, { headers })).json()) as {
    images?: Array<{ url: string }>;
    image?: { url: string };
  };
  const url = out.images?.[0]?.url ?? out.image?.url;
  if (!url) throw new Error(`fal returned no image url: ${JSON.stringify(out).slice(0, 300)}`);
  return { url, raw: JSON.stringify(out).slice(0, 500) };
}

export const bakeoffRouter = router({
  /** Run ONE model on ONE input; return the output image URL + timing. */
  run: protectedProcedure
    .input(
      z.discriminatedUnion("provider", [
        z.object({
          provider: z.literal("openai-edit"), // gpt-image-1 /v1/images/edits
          imageUrl: z.string().url(),
          prompt: z.string().min(1),
          options: z
            .object({
              transparent: z.boolean().default(false),
              inputFidelity: z.enum(["high", "low"]).optional(),
              quality: z.enum(["high", "medium", "low"]).optional(),
              size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional(),
            })
            .default({ transparent: false }),
        }),
        z.object({
          provider: z.literal("fal"), // any fal queue model, raw payload passthrough
          model: z.string().min(1), // e.g. "fal-ai/flux-pro/kontext/max", "fal-ai/birefnet/v2"
          body: z.record(z.string(), z.unknown()), // e.g. { prompt, image_url }
        }),
      ])
    )
    .mutation(async ({ input }) => {
      const t0 = Date.now();
      if (input.provider === "openai-edit") {
        const src = await fetch(input.imageUrl);
        if (!src.ok) throw new Error(`source download failed: ${src.status}`);
        const buf = await callImageEdit(
          Buffer.from(await src.arrayBuffer()),
          "bakeoff_src.png",
          input.prompt,
          input.options
        );
        const { url } = await storagePut(`bakeoff/openai-${Date.now()}.png`, buf, "image/png");
        return { url, ms: Date.now() - t0, provider: "openai-edit" as const };
      }
      const { url } = await callFalModel(input.model, input.body);
      return { url, ms: Date.now() - t0, provider: "fal" as const, model: input.model };
    }),
});
