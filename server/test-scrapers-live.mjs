/**
 * Live test for the 3 fixed scrapers: Wikipedia/Reddit, Open Library/StoryGraph, Open Library/Fable
 * Run: node server/test-scrapers-live.mjs
 */
import https from "https";

const TIMEOUT = 12000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout`)), TIMEOUT);
    const req = https.get(url, { rejectUnauthorized: false, headers: { "User-Agent": "NYTDesignBot/1.0", "Accept": "application/json" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        httpsGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { clearTimeout(timer); resolve(data); });
      res.on("error", e => { clearTimeout(timer); reject(e); });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

const TITLE = "Project Hail Mary";
const AUTHOR = "Andy Weir";

// Test 1: Wikipedia (Reddit slot)
console.log("\n=== 1. Wikipedia (Reddit slot) ===");
try {
  const slug = encodeURIComponent(TITLE.replace(/\s+/g, "_"));
  const raw = await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
  const d = JSON.parse(raw);
  console.log("✅ status: success");
  console.log("   description:", d.description);
  console.log("   extract (first 100):", d.extract?.slice(0, 100));
} catch (e) {
  console.log("❌ FAILED:", e.message);
}

// Test 2: Open Library (StoryGraph slot)
console.log("\n=== 2. Open Library Search (StoryGraph slot) ===");
try {
  const t = encodeURIComponent(TITLE), a = encodeURIComponent(AUTHOR);
  const raw = await httpsGet(`https://openlibrary.org/search.json?title=${t}&author=${a}&limit=1&fields=key,title,subject`);
  const d = JSON.parse(raw);
  const doc = d?.docs?.[0];
  console.log("✅ status: success");
  console.log("   subjects (first 8):", doc?.subject?.slice(0, 8));
} catch (e) {
  console.log("❌ FAILED:", e.message);
}

// Test 3: Open Library Work Details (Fable slot)
console.log("\n=== 3. Open Library Work Details (Fable slot) ===");
try {
  const t = encodeURIComponent(TITLE), a = encodeURIComponent(AUTHOR);
  const srRaw = await httpsGet(`https://openlibrary.org/search.json?title=${t}&author=${a}&limit=1&fields=key,subject_people,subject_places`);
  const sj = JSON.parse(srRaw);
  const doc = sj?.docs?.[0];
  const workKey = doc?.key?.replace("/works/", "");
  const wrRaw = await httpsGet(`https://openlibrary.org/works/${workKey}.json`);
  const wj = JSON.parse(wrRaw);
  console.log("✅ status: success");
  console.log("   subjects (first 5):", wj?.subjects?.slice(0, 5));
  console.log("   subject_people:", wj?.subject_people?.slice(0, 5));
  console.log("   subject_places:", wj?.subject_places?.slice(0, 5));
} catch (e) {
  console.log("❌ FAILED:", e.message);
}

console.log("\nDone.");
