/**
 * SourceStyleJSON — structured visual style extracted from a source Etsy product image.
 * Produced by server/styleExtractor.ts via Vision LLM analysis.
 * Stored in trend_patterns.sourceStyleJson.
 */
export interface SourceStyleJSON {
  // ─── Ink & Technique ───────────────────────────────────────────────────────
  inkColors: string[];          // e.g. ["black", "burnt orange"]
  inkColorNames: string[];      // e.g. ["matte black", "distressed rust"]
  shirtColorRole: string;       // "negative space — shirt color IS the background" | "covered by design"
  technique: string;            // "screen-print simulation" | "DTG full-color" | "vinyl cut"
  lineWeight: string;           // "thick bold outlines" | "hairline detail" | "no outlines"
  shadingMethod: string;        // "halftone dots" | "crosshatch" | "flat color" | "gradient"
  textureDetail: string;        // "heavy distress/worn" | "clean vector" | "hand-drawn organic"

  // ─── Subject & Composition ─────────────────────────────────────────────────
  subject: string;              // e.g. "skeleton holding fishing rod"
  subjectCrop: string;          // "full body centered" | "bust portrait" | "close-up face"
  composition: string;          // "centered single subject" | "badge/emblem" | "scene"
  framingDevice: string;        // "circular badge border" | "banner ribbon" | "NONE"
  scaleCoverage: string;        // "fills 80% of print area" | "small chest logo"

  // ─── Text & Mood ───────────────────────────────────────────────────────────
  textPresence: string;         // "bold headline above, subtext below" | "NONE"
  textStyle: string;            // "distressed serif all-caps" | "hand-lettered script" | "NONE"
  mood: string;                 // "irreverent humor" | "vintage nostalgia" | "aggressive"
  humorMechanism: string;       // "absurdist juxtaposition" | "wordplay" | "NONE"

  // ─── Print & Garment ───────────────────────────────────────────────────────
  printMethod: string;          // "simulated screen-print" | "DTG" | "sublimation"
  garmentStyle: string;         // "dark heather tee" | "natural cotton" | "black hoodie"
  designEra: string;            // "1970s retro" | "modern minimal" | "timeless"
  backgroundTreatment: string;  // "transparent/no background" | "white rectangle" | "shirt IS bg"
}
