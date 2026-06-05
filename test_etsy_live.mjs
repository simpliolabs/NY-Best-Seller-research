/**
 * Live Etsy API test — uses the EXACT URL and headers from fetchCrossNicheHotSellers
 */

const rawKey = process.env.ETSY_API_KEY;
const rawSecret = process.env.ETSY_API_SECRET;
const etsyApiKey = rawKey && rawSecret ? `${rawKey}:${rawSecret}` : rawKey || undefined;

console.log("=== ETSY API KEY STATUS ===");
console.log("ETSY_API_KEY present:", !!rawKey, "| length:", rawKey?.length ?? 0);
console.log("ETSY_API_SECRET present:", !!rawSecret, "| length:", rawSecret?.length ?? 0);
console.log("Combined key:", etsyApiKey ? `${etsyApiKey.slice(0, 8)}... (${etsyApiKey.length} chars)` : "NONE");
console.log("");

if (!etsyApiKey) {
  console.log("❌ FAIL LOUD: No Etsy API key — scan would use SIMULATED data (LLM fiction)");
  process.exit(0);
}

// EXACT URL from fetchCrossNicheHotSellers line 132
const searchQuery = "hiking shirt graphic";
const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(searchQuery)}&limit=8&sort_on=score&is_best_seller=true`;

console.log("=== LIVE ETSY API CALL ===");
console.log("URL:", url);
console.log("");

try {
  const resp = await fetch(url, {
    headers: { "x-api-key": etsyApiKey },
    signal: AbortSignal.timeout(8000),
  });

  console.log("HTTP Status:", resp.status, resp.statusText);

  if (!resp.ok) {
    const errorBody = await resp.text();
    console.log("❌ ERROR BODY:", errorBody.slice(0, 500));
    process.exit(0);
  }

  const data = await resp.json();
  const listings = data.results ?? [];

  console.log("✅ SUCCESS");
  console.log("results.length:", listings.length);
  console.log("count:", data.count);
  console.log("");

  if (listings.length > 0) {
    const first = listings[0];
    console.log("=== FIRST RESULT ===");
    console.log("listing_id:", first.listing_id);
    console.log("title:", first.title?.slice(0, 80));
    console.log("num_favorers:", first.num_favorers);
    console.log("is_best_seller:", first.is_best_seller);
    console.log("url field:", first.url?.slice(0, 80) ?? "NOT PRESENT");
    console.log("Has images array:", !!first.images);
    console.log("Has MainImage:", !!first.MainImage);
    console.log("images field:", first.images ? `Array[${first.images.length}]` : "NOT PRESENT");
    console.log("MainImage.url_fullxfull:", first.MainImage?.url_fullxfull ?? "NOT PRESENT");
    console.log("");

    // Test image fetch endpoint
    console.log("=== IMAGE FETCH TEST ===");
    const imgUrl = `https://openapi.etsy.com/v3/application/listings/${first.listing_id}/images`;
    const imgResp = await fetch(imgUrl, {
      headers: { "x-api-key": etsyApiKey },
      signal: AbortSignal.timeout(5000),
    });
    console.log("Image HTTP Status:", imgResp.status, imgResp.statusText);
    if (imgResp.ok) {
      const imgData = await imgResp.json();
      const firstImg = imgData.results?.[0];
      console.log("Image results.length:", imgData.results?.length ?? 0);
      console.log("url_570xN:", firstImg?.url_570xN ?? "NOT PRESENT");
      console.log("url_fullxfull:", firstImg?.url_fullxfull ?? "NOT PRESENT");
    } else {
      const imgError = await imgResp.text();
      console.log("Image fetch error:", imgError.slice(0, 300));
    }

    console.log("");
    console.log("=== FILTER ANALYSIS (all 8 results) ===");
    const MIN_FAVORITES = 500;
    const TITLE_BLOCKLIST = [
      "custom", "personalized", "customized", "personalised", "made to order",
      "your name", "your text", "add your",
      "polo", "performance", "hawaiian", "sublimation", "all over print",
      "allover", "full print", "jersey", "dri-fit", "moisture wicking",
      "embroidered", "embroidery",
    ];

    let passCount = 0;
    let failFavorites = 0;
    let failBlocklist = 0;

    for (const listing of listings) {
      const title = (listing.title ?? "").toLowerCase();
      const favorites = listing.num_favorers ?? 0;
      const blocked = TITLE_BLOCKLIST.find(t => title.includes(t));

      if (favorites < MIN_FAVORITES) {
        failFavorites++;
        console.log(`  FAIL-FAVS (${favorites} < ${MIN_FAVORITES}): "${listing.title?.slice(0, 60)}"`);
      } else if (blocked) {
        failBlocklist++;
        console.log(`  FAIL-BLOCK ("${blocked}"): "${listing.title?.slice(0, 60)}"`);
      } else {
        passCount++;
        console.log(`  PASS (${favorites} favs): "${listing.title?.slice(0, 60)}"`);
      }
    }

    console.log("");
    console.log(`Summary: ${passCount} pass | ${failFavorites} fail-favorites | ${failBlocklist} fail-blocklist`);
    console.log(`Need >= 4 to use live mode. Got: ${passCount}`);
    if (passCount < 4) {
      console.log("⚠️ WOULD FALL BACK TO LLM SIMULATION");
    } else {
      console.log("✅ WOULD USE LIVE MODE");
    }
  } else {
    console.log("⚠️ Zero results returned from Etsy API");
  }
} catch (err) {
  console.log("❌ FETCH ERROR:", err.message);
}
