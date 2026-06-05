import fs from "fs";
import crypto from "crypto";

const BUILT_IN_FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const BUILT_IN_FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const baseUrl = BUILT_IN_FORGE_API_URL.replace(/\/+$/, "") + "/";
const key = `test-designs/llama_white_bg_${crypto.randomUUID().slice(0,8)}.png`;

const uploadUrl = new URL("v1/storage/upload", baseUrl);
uploadUrl.searchParams.set("path", key);

const buf = fs.readFileSync("/tmp/bug1_white_bg_test.png");
const blob = new Blob([buf], { type: "image/png" });
const form = new FormData();
form.append("file", blob, "llama_white_bg.png");

const resp = await fetch(uploadUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${BUILT_IN_FORGE_API_KEY}` },
  body: form,
});

console.log("Status:", resp.status);
const data = await resp.json();
console.log("URL:", data.url);
