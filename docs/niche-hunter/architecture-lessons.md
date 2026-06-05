# Convergence Drawer — Niche Hunter Image Generation Arc

**Filed:** 2026-06-02  
**Arc span:** 6 rounds (Forge prompt scaffolding → gpt-image-2 minimal template)  
**Status:** Converged. Model swap shipped to production.

---

## Summary

The Niche Hunter image generation pipeline went through six iterative rounds attempting to make Forge's ImageService produce faithful character-swap edits (e.g., Bigfoot → Llama on a t-shirt design). Each round added more prompt constraints — growing from a 3-line directive to a 20-line HARD RULES scaffold with prohibition axes, preservation axes, style interpolation blocks, anatomy specs, and defensive language. None of it worked reliably. Switching to gpt-image-2 with a single sentence deleted all of it and produced superior results on the first call.

---

## Architecture Lessons

### (a) Forge → gpt-image-2 swap deletes ~all prompt scaffolding

The old `buildGenerationPayload` edit_source path contained:

| Component | Lines | Purpose |
|-----------|-------|---------|
| 9-field `styleDesc` interpolation | 10 | Force style fidelity |
| Token-overlap matching algorithm | 30 | Find TARGET_CHARACTER |
| `HARD RULES` header | 1 | Signal importance |
| `THE ONE CHANGE` section | 3 | Character swap directive |
| `WHAT MUST NOT CHANGE` section (5 rules) | 6 | Preservation axis |
| `ABSOLUTE PROHIBITIONS` section (4 rules) | 5 | Prohibition axis |
| Output format directive | 1 | Transparent background |

**Total: ~56 lines of prompt engineering.**

The gpt-image-2 replacement:

```
Instead of a ${sourceSubject}, change it to a ${targetCharacter} on this ${shirtDesc}.
${subjectCrop} composition matching the reference.
```

**Total: 2 lines.** The token-overlap matching algorithm (30 lines) is retained because it serves a data-lookup purpose, not a prompt-engineering purpose.

### (b) Growing prompts to constrain a model usually signals wrong model, not better prompting

The pattern across rounds 1–5 was consistent: each failure was diagnosed as "the prompt didn't constrain enough," leading to another prohibition or preservation rule. This is a diagnostic signal:

> **If you need more than ~2 sentences to describe what an image edit should do, the model cannot natively understand the edit operation. Adding constraints is compensating for a capability gap, not closing it.**

gpt-image-2 understands "change X to Y" as a native operation. Forge's ImageService treats the prompt as a generation directive with a reference image — it does not have a native "edit" concept, so every constraint is fighting the model's default behavior.

### (c) Text rendering inline cancels the "text as composited layer" plan

Spike C proved that gpt-image-2 renders text correctly inline ("DINK RESPONSIBLY" — perfectly spelled). This eliminates the planned future work of:

- Extracting text regions from source images
- Rendering text separately via a typography engine
- Compositing text back onto the generated image

**Canceled permanently.** If gpt-image-2 ever regresses on text, revisit — but do not pre-build the compositor.

### (d) Character-swap composite pipeline cancelled

The planned "crop source character → edit cropped region → composite back" pipeline is unnecessary. gpt-image-2 handles full-image character replacement from a single sentence. The crop-edit-composite approach was designed to work around Forge's inability to isolate the edit region — a limitation that does not exist in gpt-image-2.

**Canceled permanently.**

### (e) DTF upscale is the one remaining sub-round

gpt-image-2 outputs 1024×1024 maximum (confirmed by spike). For the preview→approval→Shopify-draft flow, 1024×1024 is sufficient. For DTF (Direct-to-Film) print export at 300 DPI on a 12" print area, 3600×3600 is required.

The upscale step belongs in `patternDtfProcessor.ts` only — it fires when a pattern is approved and DTF-exported, not on every scan. This keeps scan costs at ~$0.08/pattern (gpt-image-2 only) and adds ~$0.01–0.05 only for the small fraction that reach DTF export.

---

## Converged Architecture (post-swap)

```
Source Image → extractStyleFromImage (Vision LLM)
                    ↓
            sourceStyleJSON (20 fields)
                    ↓
  deconstructAndAdapt (LLM) → adaptedConcept text
                    ↓
  buildGenerationPayload → one-sentence prompt
                    ↓
  callGptImage2Edit → 1024×1024 PNG → S3
                    ↓
  trend_patterns.previewImageUrl (durable CDN)
                    ↓
  [approval gate]
                    ↓
  patternDtfProcessor → upscale to 3600×3600 → DTF export
```

The next session searches for and validates this converged architecture against the live production path.

---

## Decision Log

| Round | What was tried | Outcome |
|-------|---------------|---------|
| 1 | Basic Forge edit with 3-line prompt | Wrong character, wrong style |
| 2 | Added styleDesc interpolation (9 fields) | Partial style match, still wrong character |
| 3 | Added HARD RULES + preservation axis | Character correct sometimes, extra elements injected |
| 4 | Added prohibition axis + "STYLE REFERENCE ONLY" inversion | Overconstrained — blank outputs |
| 5 | Added anatomy specs + defensive language | Inconsistent — sometimes good, usually bad |
| 6 | Switched to gpt-image-2, one sentence | Clean llama, dense crosshatch, first call. Shipped. |

---

## Addendum: Mockup Compositor Arc (2-round convergence)

**Filed:** 2026-06-02  
**Arc span:** 2 rounds (print zone bugs → garment-relative bbox)  
**Status:** Converged. All 3 bugs fixed, visual acceptance passed.

---

### (f) Bug 1 architectural debt: opaque white + flood-fill workaround

gpt-image-2's `edit` endpoint does **not** support `background: "transparent"` (returns 400). The workaround is to prompt "output design on a plain white background" and flood-fill white → transparent in the compositor.

**Known limitation:** This silently corrupts any design containing intentional white pixels (white text, snow, stars, white outlines). The flood-fill threshold (R>240, G>240, B>240) cannot distinguish "background white" from "design white."

**Fallback for designs containing white:** Prompt gpt-image-2 to output on magenta (#FF00FF) background instead of white. Then chromakey on magenta in the compositor. Magenta is never used in commercial t-shirt designs, making it a safe key color.

**Implementation path (when needed):**
1. Detect if the source design contains significant white (>5% white pixels in the design region)
2. If yes: prompt "on a solid magenta (#FF00FF) background"
3. Compositor: chromakey magenta instead of flood-fill white

**Not implemented now** because current pipeline designs (etched crosshatch, line art) contain no white. File this as a known debt for when the pipeline handles photographic or snow-themed designs.

---

### (g) Print zones must be garment-relative, not photo-relative

The original system stored print zones as fractions of the mockup **photo** dimensions (`{x: 0.29, y: 0.23, w: 0.42, h: 0.54}`). This breaks when:
- Different garment templates have different photo framing
- Same template is re-shot at different zoom
- Photo is cropped or resized

**Converged answer:** Vision LLM detects the garment bounding box once per template (cached in DB by `template_id`). Print zones are stored as fractions of the **garment bbox**. At composite time, `resolveZoneToPhoto()` converts garment-relative → photo-relative using the per-template bbox.

**Cache key is `template_id`**, not image hash. This is correct — if the template photo changes, the bbox should be re-detected (delete the cached value), not silently served stale.

**Invariance proof:**
- Aspect-ratio invariance: 0.1% center spread across tee/tank/hoodie
- Photo-zoom invariance: 0.2% center spread across full/80%/65% crop

---

### (h) Converged mockup compositor architecture

```
Design PNG (white bg) → flood-fill white → transparent RGBA
                              ↓
Template photo → getGarmentBbox(templateId) → cached bbox
                              ↓
printZone (garment-relative) → resolveZoneToPhoto(zone, bbox) → photo-relative rect
                              ↓
sharp.composite(design resized to zone, positioned at resolved coords)
                              ↓
Final mockup PNG → S3
```

**The next session** searches "mockup placement" or "garment-relative bbox" and finds this converged answer instead of relearning that percentages-of-photo were the wrong unit.

---

## Addendum: Print AREA Refactor (supersedes zone-as-rectangle)

**Filed:** 2026-06-03  
**Status:** Converged. Supersedes the "print zone" concept from the prior round.

---

### (i) "Print zone" was the wrong abstraction — "print AREA" is correct

The prior round fixed Bug 3 (garment-relative fractions) but left the zone sized for a specific design. The PO's feedback exposed the real problem: a zone sized `{0.30, 0.18, 0.40, 0.32}` constrains portrait designs to pocket-print size because contain-fit is bound by the zone's short height.

**Correct abstraction:** The stored geometry is not a "zone for this design" — it is the **maximum realistic ink envelope** for the garment type. It is design-independent and template-specific (tee, hoodie, mug each get different envelopes).

**Standard tee envelope:** `{x: 0.20, y: 0.10, w: 0.60, h: 0.50}` of garment bbox. This represents the full printable chest area from collar to navel, shoulder to shoulder.

---

### (j) Contain-fit + top-anchor is the correct placement algorithm

| Algorithm | Behavior | Verdict |
|-----------|----------|---------|
| Center-anchor | Design drifts toward navel for tall designs | ❌ Rejected |
| Cover-fit | Clips design silhouette at zone edges | ❌ Rejected (silhouette IS the product) |
| Contain-fit + top-anchor | Design fills bound axis, sits at top of area | ✅ Shipped |

**Portrait designs** (llama, 789×997): fill area HEIGHT (50% of garment), centered horizontally, top-anchored. Looks like a full chest print.

**Landscape designs** (banner, 1000×450): fill area WIDTH (60% of garment), top-anchored, shorter vertically. Looks like a logo/banner placement.

Neither is clipped. Neither is too small. Both look like real screen-printed graphic tees.

---

### (k) The relW spread across templates is expected, not a bug

Test 1 showed 9.26% relW spread across 3 templates. This is correct because garment widths differ (Ivory is narrower than Espresso). The **invariant** properties are:
- `topY`: 0.03% spread (placement is invariant)
- `centerX`: 0.11% spread (centering is invariant)
- `relH`: 0.08% spread (fill ratio on bound axis is invariant)

The `relW` varies because it's the **unbound axis** in contain-fit for a portrait design. This is mathematically correct and visually correct.

---

### Updated converged architecture

```
Design PNG (white bg) → flood-fill white → transparent RGBA → trim to content
                              ↓
Template photo → getGarmentBbox(templateId) → cached bbox
                              ↓
printArea (garment-relative, design-independent envelope)
  → resolveZoneToPhoto(area, bbox) → photo-relative rect
                              ↓
Contain-fit design into resolved rect → TOP-ANCHOR vertically, CENTER horizontally
                              ↓
sharp.composite(design at resolved coords)
                              ↓
Final mockup PNG → S3
```

**Key distinction from prior round:** The stored geometry is the AREA (max envelope), not a zone sized for a specific design. The design adapts to the area via contain-fit, not the other way around.
