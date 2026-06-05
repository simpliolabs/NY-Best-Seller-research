import dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/nyt-design-bot/.env" });
import sharp from "sharp";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SOURCE_IMAGE_URL = "https://i.etsystatic.com/54289425/r/il/4df21a/7981232140/il_fullxfull.7981232140_3zpt.jpg";
const PROMPT = "Instead of a Bigfoot blowing a dandelion puff, change it to a Llama blowing a dandelion on this dark heather tee. bust portrait composition matching the reference.";

const imgResp = await fetch(SOURCE_IMAGE_URL, { signal: AbortSignal.timeout(15000) });
const imgBuf = Buffer.from(await imgResp.arrayBuffer());
console.log("Source downloaded:", imgBuf.length, "bytes");

const variants = [
  { label: "size=3840x3840, quality=high", size: "3840x3840", quality: "high" },
  { label: "size=3072x3072, quality=high", size: "3072x3072", quality: "high" },
];

for (const v of variants) {
  console.log("\nTesting:", v.label);
  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("prompt", PROMPT);
  formData.append("size", v.size);
  if (v.quality) formData.append("quality", v.quality);
  const blob = new Blob([imgBuf], { type: "image/jpeg" });
  formData.append("image[]", blob, "source.jpg");

  const t0 = Date.now();
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(300000),
  });
  const elapsed = Date.now() - t0;

  if (resp.ok) {
    const data = await resp.json();
    const item = data.data[0];
    let resultBuf;
    if (item.b64_json) resultBuf = Buffer.from(item.b64_json, "base64");
    else if (item.url) { const dl = await fetch(item.url); resultBuf = Buffer.from(await dl.arrayBuffer()); }
    const metadata = await sharp(resultBuf).metadata();
    console.log("  Status: 200 OK");
    console.log("  Dimensions:", metadata.width + "x" + metadata.height);
    console.log("  File size:", (resultBuf.length / 1024 / 1024).toFixed(2), "MB");
    console.log("  Latency:", (elapsed / 1000).toFixed(1) + "s");
  } else {
    const errText = await resp.text();
    console.log("  Status:", resp.status, resp.statusText);
    console.log("  Error:", errText.substring(0, 300));
  }
}

console.log("\nDone.");
