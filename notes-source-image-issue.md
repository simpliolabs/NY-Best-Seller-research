# Source Image Issue — Shirt Photo vs Isolated Artwork

## Problem
The Etsy source images are product mockup photos (shirt flat-lay on a background).
When gpt-image-1 receives this as `image[]` with a "Replace the Dalmatian with a T-Rex" prompt,
it edits the ENTIRE photo — including the shirt. The `background:"transparent"` parameter
removes the gray background but keeps the shirt as part of the "subject."

## Source Image: Dalmatian Tattoo
- URL: https://i.etsystatic.com/56971892/r/il/8a9e41/8080154511/il_fullxfull.8080154511_lojg.jpg
- Content: Black t-shirt flat-lay with a vintage-style artwork of two Dalmatians (one tattooing the other)
- The artwork is a rectangular print on the shirt chest area

## What the model did
- Replaced Dalmatians with T-Rexes ✅
- Kept the vintage style ✅
- Kept the shirt in the output ❌ (treated shirt+artwork as the subject)
- Interpreted "tattoo gun" as a real gun ❌

## Fix Options
1. **Pre-extract artwork from shirt photo** — crop just the design area before passing to edit endpoint
   - Pro: Clean input = clean output
   - Con: Requires reliable artwork detection/extraction from product photos
   
2. **Use the source image as style reference only, generate new** — don't use /edits at all
   - Pro: No shirt contamination
   - Con: Loses the exact composition/pose fidelity

3. **Add "Extract only the artwork, not the shirt" to the prompt**
   - Pro: Simple
   - Con: May not work reliably

## Decision
Option 1 is the correct fix. We already have garment detection (garmentDetector.ts).
We can use it to find the print zone on the source image and crop just that area.
