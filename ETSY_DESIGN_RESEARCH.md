# Etsy/Market Design Research — What Actually Sells

## Key Findings from Etsy "pickleball funny shirts" (top sellers)

### Style Categories That Dominate:

1. **Comfort Colors® garment-dyed + simple typography** (MOST COMMON)
   - Muted, washed-out garment colors (slate, dusty blue, sage, mauve)
   - Simple 1-2 color screen-print style graphics
   - Clean sans-serif or retro serif typography
   - Minimal illustration (small icon + big text)
   - Examples: "Soft Serve Ice Cream" pickle, "Pickleball Mahjong Repeat"

2. **Cute character illustrations** (HIGH SELLERS)
   - Frogs playing pickleball (HUGE trend)
   - Geese/silly goose with paddles
   - Cats playing pickleball
   - Style: hand-drawn, soft, whimsical — NOT cartoonish/clip-art
   - Muted color palettes, textured backgrounds

3. **Retro/vintage typography-forward** (STRONG SELLERS)
   - Retro stripes, arched text, 70s color palettes
   - "Club" and "Society" branding (Pickleball Club est. 2024)
   - Distressed/worn texture overlay
   - Limited palette: 3-4 colors max

4. **Minimalist line-art** (GROWING)
   - Single-weight line drawings
   - Small chest placement
   - Elegant, understated

## Sloth Hiking Club (slothhikingclub.com) — $34.95/shirt, 25k+ customers

### Their winning formula:
- **Vintage outdoor illustration** — looks hand-drawn, not digital
- **Earth tone palette**: forest green, burnt orange, cream, brown, dusty rose
- **Distressed/weathered texture** on ALL designs
- **Screen-print aesthetic** — limited colors, halftone dots visible
- **Nature scenes with depth** — trees, mountains, animals
- **Typography**: hand-lettered or vintage serif, always textured
- **Composition**: badge/emblem shapes, circular designs, arch layouts
- **Humor style**: dry, understated ("Out of Breath Hiking Society")

## What Our Pipeline Generates (BAD):

- Bright saturated colors (neon green, bright blue, hot red)
- Clean digital vector style (no texture, no grain)
- Cartoonish character proportions
- Too many colors (5-8 colors)
- Looks like AI clip-art / children's sticker
- Overly literal interpretations
- Complex multi-element compositions that look busy

## The Gap:

| Aspect | What Sells | What We Generate |
|--------|-----------|-----------------|
| Colors | 2-4 muted/earth tones | 5-8 bright saturated |
| Texture | Distressed, worn, screen-print grain | Clean, smooth, digital |
| Style | Hand-drawn, vintage, retro | Cartoonish, vector, clip-art |
| Typography | Textured, hand-lettered, retro serif | Clean digital fonts |
| Composition | Badge/emblem, typography-forward | Busy multi-element scenes |
| Mood | Understated, dry humor, cozy | Loud, literal, juvenile |
| Format | Screen-print look (limited colors) | Full-color digital print |

## Root Cause in Prompting:

The IMAGE_PROMPT_SYSTEM is designed for **NYT book fan merch** (IP-specific fictional worlds). 
For **niche_hunter** workspaces (pickleball, hiking, etc.), the prompt:
1. References "fictional world" and "World Bible" — irrelevant for niche sports
2. Asks for "illustrator style" from book covers — doesn't apply
3. Doesn't specify the market-proven aesthetic (vintage, distressed, muted)
4. Doesn't enforce limited color count for screen-print look
5. The "Cartoonish, slightly exaggerated" style tag from concept generation feeds directly into image gen

## Fix Required:

A separate `NICHE_IMAGE_PROMPT_SYSTEM` for niche_hunter workspaces that:
1. Enforces vintage/retro screen-print aesthetic
2. Limits to 2-4 muted/earth-tone colors
3. Requires distressed/worn texture
4. Specifies hand-drawn illustration style (not vector/digital)
5. Uses badge/emblem/typography-forward compositions
6. References real market competitors (Comfort Colors style, outdoor brand aesthetic)
7. Removes all book/IP/World Bible references
