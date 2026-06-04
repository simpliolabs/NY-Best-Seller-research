// fal bake-off: Flux Kontext vs Qwen-Image-Edit on the 3 source shirt photos.
// Clean, hand-authored edit instructions (no adaptedConcept contamination), DTF-aware,
// preserve-the-rest. Run in the Manus sandbox where FAL_KEY is set:
//     export FAL_KEY=<from app secrets>   # value lives in your secrets, not here
//     node fal_bakeoff.mjs
// Paste the final "=== BAKEOFF RESULTS (JSON) ===" block back to Claude.

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) { console.error("FAL_KEY not set in env"); process.exit(1); }
const H = { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" };

const MODELS = {
  kontext: "fal-ai/flux-pro/kontext",
  qwen: "fal-ai/qwen-image-edit",
};

const JOBS = [
  {
    design: "IFixShit",
    image: "https://i.etsystatic.com/59749583/r/il/9bd63e/7886518261/il_fullxfull.7886518261_3cvm.jpg",
    prompt:
      "Edit the printed graphic on this t-shirt in place. This is a surgical find-and-replace, NOT a redesign. " +
      "Change ONLY the wording 'I FIX SHIT' to 'I DINK SHOTS', keeping the identical distressed gold lettering style, weight, size, position, and the 'THAT'S WHAT I DO' subline and underline rules. " +
      "Preserve everything else exactly. Use bold solid shapes suitable for DTF printing - no fine specks, stipple, or hairlines. " +
      "Keep the shirt, fabric, and background completely unchanged. Add nothing new.",
  },
  {
    design: "Salty",
    image: "https://i.etsystatic.com/47029630/r/il/55b691/7954295575/il_fullxfull.7954295575_eurz.jpg",
    prompt:
      "Edit the printed graphic on this t-shirt in place. This is a surgical find-and-replace, NOT a redesign. " +
      "Keep the woman with the umbrella EXACTLY as drawn - same pose, same yellow dress, same line-art style; do not redraw her. " +
      "Change the wordmark 'SALTY' to 'SALTY DINKER' (add 'DINKER' directly under 'SALTY' in the same serif font). " +
      "Add nothing else: no salt shaker, no sunglasses, no extra props, no tagline, no brand text. " +
      "Render any rain as a few BOLD solid streaks, never fine lines or scattered dots (DTF-safe). Keep the shirt and background unchanged.",
  },
  {
    design: "Dinosaur",
    image: "https://i.etsystatic.com/65487660/r/il/c3345f/7934498606/il_fullxfull.7934498606_ft0j.jpg",
    prompt:
      "Edit the printed graphic on this t-shirt in place. Keep the vintage natural-history dinosaur illustration style and palette. " +
      "Adapt the scene to pickleball by adding a pickleball net and one or two solid pickleball paddles used by the dinosaurs, plus a perforated pickleball. " +
      "A pickleball paddle is a solid rounded paddle with a short handle - NOT a tennis racquet with strings and NOT a thin disc or frisbee. " +
      "Do NOT add any text, title, or wordmark. Use bold solid shapes (DTF-safe). Keep the shirt and background unchanged.",
  },
];

async function runOne(modelId, image_url, prompt) {
  const sub = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST", headers: H, body: JSON.stringify({ prompt, image_url }),
  });
  if (!sub.ok) return { error: `submit ${sub.status}: ${(await sub.text()).slice(0, 200)}` };
  const { status_url, response_url } = await sub.json();
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await (await fetch(status_url, { headers: H })).json();
    if (st.status === "COMPLETED") {
      const out = await (await fetch(response_url, { headers: H })).json();
      const url = out?.images?.[0]?.url;
      return url ? { url } : { error: `no image: ${JSON.stringify(out).slice(0, 200)}` };
    }
    if (st.status === "FAILED" || st.error) return { error: `failed: ${JSON.stringify(st).slice(0, 200)}` };
  }
  return { error: "timeout (240s)" };
}

const results = {};
for (const job of JOBS) {
  results[job.design] = {};
  for (const [name, modelId] of Object.entries(MODELS)) {
    process.stdout.write(`[${job.design}/${name}] running... `);
    try {
      const r = await runOne(modelId, job.image, job.prompt);
      results[job.design][name] = r;
      console.log(r.url ? `OK ${r.url}` : `ERR ${r.error}`);
    } catch (e) {
      results[job.design][name] = { error: String(e) };
      console.log(`EXC ${e}`);
    }
  }
}
console.log("\n\n=== BAKEOFF RESULTS (JSON) ===");
console.log(JSON.stringify(results, null, 2));
