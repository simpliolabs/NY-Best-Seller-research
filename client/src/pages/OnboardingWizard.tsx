/**
 * OnboardingWizard — Phase B (v2)
 *
 * 4-step wizard to create a new niche_hunter workspace:
 *   Step 1: Name + icon
 *   Step 2: Research — copy ChatGPT Pro prompt OR paste JSON OR quick AI generate
 *   Step 3: Review & edit full profile (CulturalMapEditor for deep map)
 *   Step 4: Confirm + create
 *
 * Karpathy P2: wizard state lives entirely in this component.
 * No server draft persistence. No streaming.
 */
import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  ArrowLeft, ArrowRight, Sparkles, CheckCircle2, Loader2,
  X, Plus, Copy, Check, Upload, FileJson, ChevronDown, ChevronRight
} from "lucide-react";
import type { NicheProfile } from "@/../../server/onboardingRouter";
import CulturalMapEditor from "@/components/CulturalMapEditor";
import type { CulturalMap } from "@/../../server/onboardingRouter";

// ─── Types ───────────────────────────────────────────────────────────────────
type Step = 1 | 2 | 3 | 4;
type Step2Mode = "prompt" | "paste" | "ai";

const STEP_LABELS: Record<Step, string> = {
  1: "Name Your Workspace",
  2: "Research Your Niche",
  3: "Review & Edit Profile",
  4: "Confirm & Create",
};

const ICONS = ["🎯", "🏓", "🐾", "🌿", "🏔️", "🎸", "🚀", "🎨", "🌊", "🦋", "🏕️", "🎭"];

// ─── ChatGPT Research Prompt Generator ───────────────────────────────────────
function buildChatGptPrompt(nicheName: string): string {
  return `You are a world-class print-on-demand niche research expert. I need a DEEP research profile for the "${nicheName}" niche for selling funny/clever graphic t-shirts on Etsy.

Return ONLY a valid JSON object (no markdown, no explanation, just raw JSON) matching this EXACT structure:

{
  "summary": "2-3 sentence description of who buys in this niche, their demographics, psychographics, and buying behavior",
  "targetAudience": "One-line description of the ideal buyer",
  "subreddits": ["list", "of", "subreddits", "DIRECTLY about this niche — no generic ones"],
  "etsyKeywords": ["search terms buyers type on Etsy for THIS niche", "include: funny X shirt, X gift, X dad shirt, X mom shirt, X player shirt, X lover gift, X humor tee — be very specific"],
  "crossNicheCategories": ["other niches whose humor/visual style transfers well — e.g. hiking shirt, yoga tee, fishing shirt — NOT the same niche"],
  "generalBestSellerTerms": ["broad product-type best-seller terms — e.g. funny shirt, graphic tee, humor tee — 3-5 terms"],
  "designStyles": ["visual styles that resonate — e.g. vintage distressed, minimalist line art, cartoon/comic style, typographic humor"],
  "avoidTopics": ["oversaturated angles, generic slogans, competitor niches to avoid"],
  "culturalMap": {
    "animalMascots": [
      {
        "animal": "Animal name",
        "whyItWorks": "SPECIFIC reason this animal's body, personality, or cultural meaning maps to ${nicheName} humor (e.g. T-Rex = short arms can't reach high volleys; Llama = long neck for reaching shots, spits when frustrated)",
        "visualTreatment": "How to draw/style it for a t-shirt (e.g. wearing gear, doing the activity, reacting to a pain point)"
      }
    ],
    "painPoints": [
      {
        "pain": "Real frustration this community experiences",
        "humorAngle": "How to turn this into funny t-shirt copy or visual"
      }
    ],
    "funPoints": [
      {
        "joy": "A joyful/satisfying moment unique to this niche",
        "visualConcept": "How to visualize this on a t-shirt"
      }
    ],
    "insideJokes": [
      {
        "joke": "Actual joke, meme, or phrase the community uses",
        "context": "Why insiders find this funny — what you need to know to get it"
      }
    ],
    "physicalComedy": [
      {
        "scenario": "A funny physical scenario specific to this activity",
        "whyFunny": "Why this is universally relatable to people in this niche"
      }
    ],
    "catchphrases": ["Real phrases this community says", "slang terms", "battle cries", "self-deprecating sayings"],
    "rivalries": [
      {
        "rivalry": "The rival group or activity",
        "tension": "What the tension is about",
        "humorAngle": "How to make this funny on a shirt without being mean"
      }
    ],
    "lifestyleIdentity": [
      {
        "trait": "Identity trait that drives this person to buy apparel",
        "purchaseDriver": "Why they'd wear this publicly — what it signals about them"
      }
    ],
    "transferableVisualConcepts": [
      {
        "sourceNiche": "The niche this visual formula comes from",
        "sourcePattern": "The specific visual pattern (e.g. 'Gone Fishing' sign, 'Dog Mom' badge)",
        "targetAdaptation": "How to adapt it for ${nicheName}",
        "whyItTransfers": "Why this formula resonates with ${nicheName} buyers"
      }
    ]
  }
}

REQUIREMENTS:
- animalMascots: Give 5-7 animals minimum. MUST include at least one sport-specific physical comedy animal (body shape maps to the activity) AND one quirky/lovable animal (llama, capybara, axolotl, etc.). Think creatively.
- insideJokes: Give 6-10 jokes. These must be things ONLY insiders would recognize.
- catchphrases: Give 8-12 phrases. Real community vocabulary only.
- All arrays must have at least 3-5 items unless specified otherwise.
- Be specific. Generic answers are useless. Think like a ${nicheName} obsessive who also designs shirts.

Niche: ${nicheName}`;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function OnboardingWizard() {
  const [, setLocation] = useLocation();
  const { setActiveWorkspace } = useWorkspace();
  const utils = trpc.useUtils();

  // Step state
  const [step, setStep] = useState<Step>(1);

  // Step 1 fields
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [icon, setIcon] = useState("🎯");
  const [slugTouched, setSlugTouched] = useState(false);

  // Step 2 state
  const [step2Mode, setStep2Mode] = useState<Step2Mode>("prompt");
  const [description, setDescription] = useState("");
  const [jsonPaste, setJsonPaste] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3 — enriched profile (editable)
  const [profile, setProfile] = useState<NicheProfile | null>(null);

  // Mutations
  const enrichMutation = trpc.onboarding.enrichNiche.useMutation();
  const finalizeMutation = trpc.onboarding.finalizeWorkspace.useMutation();

  // ── Slug auto-generation from name ──────────────────────────────────────
  function handleNameChange(val: string) {
    setName(val);
    if (!slugTouched) {
      setSlug(val.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    }
  }

  // ── Copy prompt to clipboard ────────────────────────────────────────────
  async function handleCopyPrompt() {
    await navigator.clipboard.writeText(buildChatGptPrompt(name));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // ── Parse + validate pasted JSON ────────────────────────────────────────
  function parseAndLoadJson(raw: string): boolean {
    setJsonError(null);
    try {
      const parsed = JSON.parse(raw);
      // Basic shape check
      if (!parsed.summary || !parsed.culturalMap) {
        setJsonError("JSON is missing required fields (summary, culturalMap). Make sure you copied the full output.");
        return false;
      }
      // Ensure all culturalMap arrays exist
      const cm = parsed.culturalMap;
      const defaults = {
        animalMascots: [], painPoints: [], funPoints: [], insideJokes: [],
        physicalComedy: [], catchphrases: [], lifestyleIdentity: [],
        rivalries: [], transferableVisualConcepts: [],
      };
      parsed.culturalMap = { ...defaults, ...cm };
      // Ensure top-level arrays exist
      parsed.subreddits = parsed.subreddits ?? [];
      parsed.etsyKeywords = parsed.etsyKeywords ?? [];
      parsed.crossNicheCategories = parsed.crossNicheCategories ?? [];
      parsed.generalBestSellerTerms = parsed.generalBestSellerTerms ?? [];
      parsed.designStyles = parsed.designStyles ?? [];
      parsed.avoidTopics = parsed.avoidTopics ?? [];
      parsed.culturalMoments = parsed.culturalMoments ?? [];
      setProfile(parsed as NicheProfile);
      return true;
    } catch (e) {
      setJsonError("Invalid JSON. Make sure you copied the full output from ChatGPT without any extra text.");
      return false;
    }
  }

  // ── Handle file upload ───────────────────────────────────────────────────
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setJsonPaste(text);
      parseAndLoadJson(text);
    };
    reader.readAsText(file);
  }

  // ── Import JSON and advance to Step 3 ───────────────────────────────────
  function handleJsonImport() {
    if (parseAndLoadJson(jsonPaste)) {
      setStep(3);
    }
  }

  // ── Step 2 → 3: call LLM enrichment ────────────────────────────────────
  async function handleEnrich() {
    const result = await enrichMutation.mutateAsync({ description, workspaceName: name });
    setProfile(result);
    setStep(3);
  }

  // ── Step 3 → 4: just advance ────────────────────────────────────────────
  function handleReviewConfirm() {
    setStep(4);
  }

  // ── Step 4: finalize ────────────────────────────────────────────────────
  async function handleFinalize() {
    if (!profile) return;
    const workspace = await finalizeMutation.mutateAsync({ name, slug, icon, nicheProfile: profile });
    await utils.workspace.list.invalidate();
    setActiveWorkspace({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      icon: workspace.icon,
      workspaceType: workspace.workspaceType as "nyt" | "niche_hunter",
    });
    setLocation(`/${workspace.slug}`);
  }

  // ── Profile array editors (for non-culturalMap fields) ──────────────────
  function updateProfileArray(field: keyof NicheProfile, index: number, value: string) {
    if (!profile) return;
    const arr = [...((profile[field] as string[]) ?? [])];
    arr[index] = value;
    setProfile({ ...profile, [field]: arr });
  }

  function removeProfileItem(field: keyof NicheProfile, index: number) {
    if (!profile) return;
    const arr = ((profile[field] as string[]) ?? []).filter((_, i) => i !== index);
    setProfile({ ...profile, [field]: arr });
  }

  function addProfileItem(field: keyof NicheProfile) {
    if (!profile) return;
    setProfile({ ...profile, [field]: [...((profile[field] as string[]) ?? []), ""] });
  }

  // ── Validation ───────────────────────────────────────────────────────────
  const step1Valid = name.trim().length > 0 && /^[a-z0-9-]+$/.test(slug) && slug.length > 0;
  const step2AiValid = description.trim().length >= 10;
  const step2JsonValid = jsonPaste.trim().length > 10;

  const chatGptPrompt = buildChatGptPrompt(name);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}>
            New Workspace
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Step {step} of 4 — {STEP_LABELS[step]}
          </p>
          <div className="mt-4 flex gap-1.5 justify-center">
            {([1, 2, 3, 4] as Step[]).map((s) => (
              <div
                key={s}
                className="h-1.5 w-12 rounded-full transition-colors"
                style={{ backgroundColor: s <= step ? "#22C55E" : "hsl(var(--muted))" }}
              />
            ))}
          </div>
        </div>

        {/* ── Step 1: Name + Icon ── */}
        {step === 1 && (
          <Card>
            <CardContent className="pt-6 space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">Workspace Name</label>
                <Input
                  placeholder="e.g. Pickleball"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">URL Slug</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground shrink-0">/workspace/</span>
                  <Input
                    placeholder="pickleball"
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    }}
                  />
                </div>
                {slug && !/^[a-z0-9-]+$/.test(slug) && (
                  <p className="text-xs text-destructive">Lowercase letters, numbers, and hyphens only</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Icon</label>
                <div className="flex flex-wrap gap-2">
                  {ICONS.map((em) => (
                    <button
                      key={em}
                      onClick={() => setIcon(em)}
                      className="text-xl w-10 h-10 rounded-lg border flex items-center justify-center transition-colors"
                      style={{
                        borderColor: icon === em ? "#22C55E" : "hsl(var(--border))",
                        backgroundColor: icon === em ? "#22C55E20" : "transparent",
                      }}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  onClick={() => setStep(2)}
                  disabled={!step1Valid}
                  style={{ backgroundColor: step1Valid ? "#22C55E" : undefined }}
                  className={step1Valid ? "text-white hover:opacity-90" : ""}
                >
                  Next <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Research ── */}
        {step === 2 && (
          <Card>
            <CardContent className="pt-6 space-y-5">
              {/* Mode tabs */}
              <div className="flex gap-1 p-1 bg-muted rounded-lg">
                {([
                  { key: "prompt", label: "ChatGPT Prompt", icon: "✨" },
                  { key: "paste", label: "Paste / Upload JSON", icon: "📋" },
                  { key: "ai", label: "Quick AI Generate", icon: "⚡" },
                ] as { key: Step2Mode; label: string; icon: string }[]).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setStep2Mode(tab.key)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-colors"
                    style={{
                      backgroundColor: step2Mode === tab.key ? "hsl(var(--background))" : "transparent",
                      color: step2Mode === tab.key ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                      boxShadow: step2Mode === tab.key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                    }}
                  >
                    <span>{tab.icon}</span> {tab.label}
                  </button>
                ))}
              </div>

              {/* ── Mode: ChatGPT Prompt ── */}
              {step2Mode === "prompt" && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3">
                    <p className="text-xs font-semibold text-green-600 dark:text-green-400 mb-1">
                      ✨ Recommended — Best results with ChatGPT Pro (GPT-5)
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Copy this prompt, paste it into ChatGPT Pro, then come back and paste the JSON output below.
                    </p>
                  </div>

                  {/* Prompt display */}
                  <div className="relative">
                    <div
                      className="rounded-md border border-border bg-muted/50 p-3 text-xs font-mono text-muted-foreground overflow-y-auto"
                      style={{ maxHeight: "280px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                    >
                      {chatGptPrompt}
                    </div>
                    <button
                      onClick={handleCopyPrompt}
                      className="absolute top-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
                      style={{
                        backgroundColor: copied ? "#22C55E" : "hsl(var(--background))",
                        color: copied ? "white" : "hsl(var(--foreground))",
                        border: "1px solid hsl(var(--border))",
                      }}
                    >
                      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>

                  <p className="text-xs text-muted-foreground text-center">
                    After getting the JSON from ChatGPT → switch to <strong>Paste / Upload JSON</strong> tab
                  </p>
                </div>
              )}

              {/* ── Mode: Paste / Upload JSON ── */}
              {step2Mode === "paste" && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Paste JSON from ChatGPT</label>
                    <p className="text-xs text-muted-foreground">
                      Paste the full JSON output from ChatGPT Pro here. Make sure to copy the entire response.
                    </p>
                    <Textarea
                      placeholder={'{\n  "summary": "...",\n  "targetAudience": "...",\n  "culturalMap": { ... }\n}'}
                      value={jsonPaste}
                      onChange={(e) => { setJsonPaste(e.target.value); setJsonError(null); }}
                      rows={10}
                      className="font-mono text-xs"
                      autoFocus
                    />
                    {jsonError && (
                      <p className="text-xs text-destructive">{jsonError}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  {/* File upload */}
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                    >
                      <Upload className="h-4 w-4" />
                      Upload .json file
                    </button>
                  </div>
                </div>
              )}

              {/* ── Mode: Quick AI Generate ── */}
              {step2Mode === "ai" && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
                    <p className="text-xs font-semibold text-yellow-600 dark:text-yellow-400 mb-1">
                      ⚡ Quick draft — uses Gemini 2.5 Pro
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Faster but less thorough than ChatGPT Pro research. Good for testing a new niche quickly.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Describe Your Niche</label>
                    <Textarea
                      placeholder={`Example: Pickleball players aged 35-65 who love humor and inside jokes about the sport. They're competitive but self-deprecating, love vintage-style graphics, and buy a lot of gear.`}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={5}
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground text-right">{description.length} chars</p>
                  </div>
                  {enrichMutation.isError && (
                    <p className="text-xs text-destructive">Failed to generate profile. Please try again.</p>
                  )}
                </div>
              )}

              {/* Navigation */}
              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>

                {step2Mode === "paste" && (
                  <Button
                    onClick={handleJsonImport}
                    disabled={!step2JsonValid}
                    style={{ backgroundColor: step2JsonValid ? "#22C55E" : undefined }}
                    className={step2JsonValid ? "text-white hover:opacity-90" : ""}
                  >
                    <FileJson className="mr-2 h-4 w-4" /> Import & Review
                  </Button>
                )}

                {step2Mode === "ai" && (
                  <Button
                    onClick={handleEnrich}
                    disabled={!step2AiValid || enrichMutation.isPending}
                    style={{ backgroundColor: step2AiValid && !enrichMutation.isPending ? "#22C55E" : undefined }}
                    className={step2AiValid && !enrichMutation.isPending ? "text-white hover:opacity-90" : ""}
                  >
                    {enrichMutation.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating…</>
                    ) : (
                      <><Sparkles className="mr-2 h-4 w-4" /> Generate AI Profile</>
                    )}
                  </Button>
                )}

                {step2Mode === "prompt" && (
                  <Button
                    onClick={() => setStep2Mode("paste")}
                    style={{ backgroundColor: "#22C55E" }}
                    className="text-white hover:opacity-90"
                  >
                    I have the JSON <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Review & Edit Profile ── */}
        {step === 3 && profile && (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6 space-y-5">
                <p className="text-xs text-muted-foreground">
                  Review and edit every field. This profile drives all future scans and design generation.
                </p>

                {/* Summary + Audience */}
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</label>
                    <Textarea
                      value={profile.summary}
                      onChange={(e) => setProfile({ ...profile, summary: e.target.value })}
                      rows={2}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target Audience</label>
                    <Input
                      value={profile.targetAudience}
                      onChange={(e) => setProfile({ ...profile, targetAudience: e.target.value })}
                    />
                  </div>
                </div>

                {/* Array fields */}
                {(
                  [
                    { key: "subreddits", label: "Subreddits to Scan" },
                    { key: "etsyKeywords", label: "Etsy In-Niche Keywords" },
                    { key: "generalBestSellerTerms", label: "General Best-Seller Terms" },
                    { key: "crossNicheCategories", label: "Cross-Niche Scan Categories" },
                    { key: "designStyles", label: "Design Styles" },
                    { key: "avoidTopics", label: "Avoid Topics" },
                  ] as { key: keyof NicheProfile; label: string }[]
                ).map(({ key, label }) => {
                  const arr = (profile[key] as string[] | undefined) ?? [];
                  return (
                    <div key={key} className="space-y-1.5">
                      <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {label}
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {arr.map((item, i) => (
                          <div key={i} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1">
                            <input
                              className="bg-transparent text-xs outline-none min-w-0 w-auto"
                              style={{ width: `${Math.max((item ?? "").length, 4)}ch` }}
                              value={item ?? ""}
                              onChange={(e) => updateProfileArray(key, i, e.target.value)}
                            />
                            <button
                              onClick={() => removeProfileItem(key, i)}
                              className="text-muted-foreground hover:text-destructive ml-0.5"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                        <button
                          onClick={() => addProfileItem(key)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-dashed border-border"
                        >
                          <Plus className="h-3 w-3" /> Add
                        </button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Deep Cultural Map — full editor */}
            {profile.culturalMap && (
              <CulturalMapEditor
                culturalMap={profile.culturalMap}
                onChange={(updated: CulturalMap) => setProfile({ ...profile, culturalMap: updated })}
              />
            )}

            <Card>
              <CardContent className="pt-4">
                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep(2)}>
                    <ArrowLeft className="mr-2 h-4 w-4" /> Back
                  </Button>
                  <Button
                    onClick={handleReviewConfirm}
                    style={{ backgroundColor: "#22C55E" }}
                    className="text-white hover:opacity-90"
                  >
                    Looks Good <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Step 4: Confirm + Create ── */}
        {step === 4 && profile && (
          <Card>
            <CardContent className="pt-6 space-y-5">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                <span className="text-4xl">{icon}</span>
                <div>
                  <p className="font-semibold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>{name}</p>
                  <p className="text-sm text-muted-foreground">/workspace/{slug}</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Niche Summary</p>
                <p className="text-sm text-muted-foreground">{profile.summary}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="font-medium mb-1">Subreddits</p>
                  <div className="flex flex-wrap gap-1">
                    {profile.subreddits.map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="font-medium mb-1">Etsy Keywords</p>
                  <div className="flex flex-wrap gap-1">
                    {profile.etsyKeywords.slice(0, 4).map((k) => (
                      <Badge key={k} variant="secondary" className="text-xs">{k}</Badge>
                    ))}
                    {profile.etsyKeywords.length > 4 && (
                      <Badge variant="secondary" className="text-xs">+{profile.etsyKeywords.length - 4}</Badge>
                    )}
                  </div>
                </div>
                <div>
                  <p className="font-medium mb-1">Mascots</p>
                  <div className="flex flex-wrap gap-1">
                    {(profile.culturalMap?.animalMascots ?? []).slice(0, 5).map((m) => (
                      <Badge key={m.animal} variant="secondary" className="text-xs">{m.animal}</Badge>
                    ))}
                    {(profile.culturalMap?.animalMascots ?? []).length > 5 && (
                      <Badge variant="secondary" className="text-xs">+{(profile.culturalMap?.animalMascots ?? []).length - 5}</Badge>
                    )}
                  </div>
                </div>
                <div>
                  <p className="font-medium mb-1">Design Styles</p>
                  <div className="flex flex-wrap gap-1">
                    {profile.designStyles.slice(0, 3).map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                    ))}
                  </div>
                </div>
              </div>

              {finalizeMutation.isError && (
                <p className="text-xs text-destructive">
                  Failed to create workspace. The slug may already be taken.
                </p>
              )}

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(3)}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={handleFinalize}
                  disabled={finalizeMutation.isPending}
                  style={{ backgroundColor: "#22C55E" }}
                  className="text-white hover:opacity-90"
                >
                  {finalizeMutation.isPending ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…</>
                  ) : (
                    <><CheckCircle2 className="mr-2 h-4 w-4" /> Create Workspace</>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cancel link */}
        <div className="mt-4 text-center">
          <button
            onClick={() => setLocation("/")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel and go back
          </button>
        </div>
      </div>
    </div>
  );
}
