/**
 * OnboardingWizard — Phase B
 *
 * 4-step wizard to create a new niche_hunter workspace:
 *   Step 1: Name + icon
 *   Step 2: Niche description (plain language)
 *   Step 3: LLM enrichment → review & edit profile
 *   Step 4: Confirm + create
 *
 * Karpathy P2: wizard state lives entirely in this component.
 * No server draft persistence. No streaming.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ArrowLeft, ArrowRight, Sparkles, CheckCircle2, Loader2, X, Plus } from "lucide-react";
import type { NicheProfile } from "@/../../server/onboardingRouter";

// ─── Types ───────────────────────────────────────────────────────────────────
type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "Name Your Workspace",
  2: "Describe Your Niche",
  3: "Review AI Profile",
  4: "Confirm & Create",
};

const ICONS = ["🎯", "🏓", "🐾", "🌿", "🏔️", "🎸", "🚀", "🎨", "🌊", "🦋", "🏕️", "🎭"];

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

  // Step 2 fields
  const [description, setDescription] = useState("");

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
    // Refresh workspace list and switch to new workspace
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

  // ── Profile field editors ────────────────────────────────────────────────
  function updateProfileArray(field: keyof NicheProfile, index: number, value: string) {
    if (!profile) return;
    const arr = [...(profile[field] as string[])];
    arr[index] = value;
    setProfile({ ...profile, [field]: arr });
  }

  function removeProfileItem(field: keyof NicheProfile, index: number) {
    if (!profile) return;
    const arr = (profile[field] as string[]).filter((_, i) => i !== index);
    setProfile({ ...profile, [field]: arr });
  }

  function addProfileItem(field: keyof NicheProfile) {
    if (!profile) return;
    setProfile({ ...profile, [field]: [...(profile[field] as string[]), ""] });
  }

  // ── Validation ───────────────────────────────────────────────────────────
  const step1Valid = name.trim().length > 0 && /^[a-z0-9-]+$/.test(slug) && slug.length > 0;
  const step2Valid = description.trim().length >= 10;

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
          {/* Progress bar */}
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

        {/* ── Step 2: Niche Description ── */}
        {step === 2 && (
          <Card>
            <CardContent className="pt-6 space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">Describe Your Niche</label>
                <p className="text-xs text-muted-foreground">
                  Write in plain language. The AI will turn this into a structured research profile.
                </p>
                <Textarea
                  placeholder={`Example: Pickleball players aged 35-65 who love humor and inside jokes about the sport. They're competitive but self-deprecating, love vintage-style graphics, and buy a lot of gear. Big on community, tournaments, and the "dinking" culture.`}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground text-right">{description.length} chars</p>
              </div>

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={handleEnrich}
                  disabled={!step2Valid || enrichMutation.isPending}
                  style={{ backgroundColor: step2Valid && !enrichMutation.isPending ? "#22C55E" : undefined }}
                  className={step2Valid && !enrichMutation.isPending ? "text-white hover:opacity-90" : ""}
                >
                  {enrichMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating profile…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Generate AI Profile
                    </>
                  )}
                </Button>
              </div>

              {enrichMutation.isError && (
                <p className="text-xs text-destructive">
                  Failed to generate profile. Please try again.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Review AI Profile ── */}
        {step === 3 && profile && (
          <Card>
            <CardContent className="pt-6 space-y-5">
              <p className="text-xs text-muted-foreground">
                Review and edit the AI-generated profile. This will guide all future research runs.
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
                  { key: "crossNicheCategories", label: "Cross-Niche Scan Categories" },
                  { key: "culturalMoments", label: "Cultural Moments / Inside Jokes" },
                  { key: "designStyles", label: "Design Styles" },
                  { key: "avoidTopics", label: "Avoid Topics" },
                ] as { key: keyof NicheProfile; label: string }[]
              ).map(({ key, label }) => (
                <div key={key} className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {(profile[key] as string[]).map((item, i) => (
                      <div key={i} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1">
                        <input
                          className="bg-transparent text-xs outline-none min-w-0 w-auto"
                          style={{ width: `${Math.max(item.length, 4)}ch` }}
                          value={item}
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
              ))}

              <div className="flex justify-between pt-2">
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
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" /> Create Workspace
                    </>
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
            className="text-xs text-muted-foreground hover:text-foreground transition-colors" // WorkspaceRedirect handles slug routing
          >
            Cancel and go back
          </button>
        </div>
      </div>
    </div>
  );
}
