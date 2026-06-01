# Screenshot Observations — Run 150001 vs Run 150003

## Run #150001 (9:40 AM, 4/28/2026)
- Books: Hope Rises (Baldacci, 255), Faith of Beasts (Corey, 255), Project Hail Mary (Weir, 193), The Correspondent (Evans, 193), Theo of Golden (Levi, 187), Yesteryear (Burke, 175)
- Images: 2 (pipeline timed out at 300s before generating all images)
- Top Pick: HOPE RISES
- Error banner: "Pipeline timed out after 300s: Timeout after 300000ms: Overall pipeline execution"
- 30 concepts, 6 books, 7/7 stages

## Run #150003 (11:52 AM, 4/28/2026)
- Books: Yesteryear (Burke, 243), Project Hail Mary (Weir, 240), Theo of Golden (Levi, 208), Faith of Beasts (Corey, 193), Hope Rises (Baldacci, 190), The Correspondent (Evans, 190)
- Images: 15 (all generated successfully)
- Top Pick: YESTERYEAR
- No error — completed successfully
- 30 concepts, 6 books, 7/7 stages

## KEY FINDING: Same 6 books in BOTH runs, just different scores/rankings!
- All 6 titles appear in both runs: Hope Rises, Faith of Beasts, Project Hail Mary, The Correspondent, Theo of Golden, Yesteryear
- The NYT API returned the same list — the "different books" perception is because:
  1. Scores changed (LLM scoring is non-deterministic)
  2. Sort order changed (books re-ranked by new scores)
  3. Run 150001 timed out (only 2 images), Run 150003 completed (15 images)
- This is NOT a "different books" bug — it's a UX problem: user can't see that the same books appear across runs because there's no cross-run view

## User's 6 Gaps
1. UX navigation: hard to see which concepts won and why
2. Image count per concept: not clear how many images each concept has
3. No thumbnails: images not showing as thumbnails on report/dashboard
4. Concept Library: 15 images not clickable, need new top-level nav showing ALL concepts ever
5. Different books between runs: need MERGE view + growth/decline charts for 30/60/90 days
6. Per-book re-run: "RUN" button on individual book pages to re-scrape + re-score + generate NEW concepts (keep old)
