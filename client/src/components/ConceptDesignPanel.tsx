/**
 * ConceptDesignPanel — Redesigned concept design section.
 * Shows ONE live design (slot A) + style regenerate + Previous versions strip.
 * Replaces the old 3-variation DesignImagePair + regenerate control.
 */
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  RefreshCw,
  Loader2,
  Paintbrush,
  Shirt,
  ShoppingBag,
  History,
  RotateCcw,
  Image as ImageIcon,
  XCircle,
  Undo2,
} from "lucide-react";

const DISMISS_TAGS = [
  { key: "too_dark", label: "Too dark / heavy" },
  { key: "too_similar", label: "Too similar to the others" },
  { key: "wrong_style", label: "Wrong / cartoonish style" },
  { key: "off_brand", label: "Off-brand / off-niche" },
  { key: "weak_humor", label: "Weak hook / not funny" },
  { key: "bad_colors", label: "Bad colors" },
  { key: "too_generic", label: "Too generic" },
  { key: "poor_composition", label: "Weak composition" },
  { key: "bad_subject", label: "Weak subject" },
] as const;

interface ConceptDesignPanelProps {
  conceptId: number;
  conceptName: string;
  headline: string | null;
  subtext: string | null;
  imageUrlA: string | null;
  productionUrlA: string | null;
  currentStyle: string | null;
  dismissedAt?: string | number | Date | null;
  rejectionTags?: string[] | null;
}

export function ConceptDesignPanel({
  conceptId,
  conceptName,
  headline,
  subtext,
  imageUrlA,
  productionUrlA,
  currentStyle,
  dismissedAt,
  rejectionTags,
}: ConceptDesignPanelProps) {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const [, navigate] = useLocation();

  // Style options + local state
  const { data: styleOptions = ["Vintage/Distressed"] } = trpc.workspace.styleOptions.useQuery();
  const [regenStyle, setRegenStyle] = useState(currentStyle || "Vintage/Distressed");

  const utils = trpc.useUtils();

  // ─── Dismiss state ──────────────────────────────────────────────────────────
  const [showDesignDismissChips, setShowDesignDismissChips] = useState(false);
  const [showConceptDismissChips, setShowConceptDismissChips] = useState(false);
  const [designTags, setDesignTags] = useState<string[]>([]);
  const [conceptTags, setConceptTags] = useState<string[]>([]);
  const isDismissed = !!dismissedAt;

  // Design-level dismiss (current live design only — concept stays active)
  const dismissDesignMutation = trpc.concepts.dismissCurrentDesign.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Design dismissed — concept stays active.");
      setShowDesignDismissChips(false);
      setDesignTags([]);
      utils.books.getById.invalidate();
      utils.library.list.invalidate();
      utils.concepts.getGenerationHistory.invalidate({ conceptId });
    },
    onError: (err) => toast.error(err.message),
  });

  // Concept-level dismiss (entire concept removed from active views)
  const dismissConceptMutation = trpc.concepts.dismiss.useMutation({
    onSuccess: () => {
      toast.success("Concept dismissed — removed from active views.");
      setShowConceptDismissChips(false);
      setConceptTags([]);
      utils.books.getById.invalidate();
      utils.library.list.invalidate();
      utils.reports.getLatest.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const undismissMutation = trpc.concepts.undismiss.useMutation({
    onSuccess: () => {
      toast.success("Concept restored to active winners.");
      utils.books.getById.invalidate();
      utils.library.list.invalidate();
      utils.reports.getLatest.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // Per-version dismiss (for individual history entries)
  const [dismissingVersionId, setDismissingVersionId] = useState<string | null>(null);
  const [versionTags, setVersionTags] = useState<string[]>([]);

  const dismissGenerationMutation = trpc.concepts.dismissGeneration.useMutation({
    onSuccess: () => {
      toast.success("Version dismissed — style signal recorded.");
      setDismissingVersionId(null);
      setVersionTags([]);
      utils.concepts.getGenerationHistory.invalidate({ conceptId });
    },
    onError: (err) => toast.error(err.message),
  });

  const undismissGenerationMutation = trpc.concepts.undismissGeneration.useMutation({
    onSuccess: () => {
      toast.success("Version restored.");
      utils.concepts.getGenerationHistory.invalidate({ conceptId });
    },
    onError: (err) => toast.error(err.message),
  });

  const toggleVersionTag = (key: string) => {
    setVersionTags((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );
  };

  const toggleDesignTag = (key: string) => {
    setDesignTags((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );
  };

  const toggleConceptTag = (key: string) => {
    setConceptTags((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );
  };

  // ─── Mutations ───────────────────────────────────────────────────────────────
  const regenerateMutation = trpc.concepts.regenerateImage.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Design regenerated!");
      utils.books.getById.invalidate();
      utils.library.list.invalidate();
      utils.reports.getLatest.invalidate();
      utils.concepts.getById.invalidate();
      utils.concepts.getGenerationHistory.invalidate({ conceptId });
    },
    onError: (err) => toast.error(err.message),
  });

  const restoreMutation = trpc.concepts.restoreGeneration.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Design restored!");
      utils.books.getById.invalidate();
      utils.library.list.invalidate();
      utils.concepts.getById.invalidate();
      utils.concepts.getGenerationHistory.invalidate({ conceptId });
    },
    onError: (err) => toast.error(err.message),
  });

  // ─── Generation history query ────────────────────────────────────────────────
  const { data: historyRaw, isLoading: historyLoading } =
    trpc.concepts.getGenerationHistory.useQuery({ conceptId });

  // Filter out the currently-live design from history, split active vs dismissed
  const displayUrl = productionUrlA || imageUrlA;
  const history = useMemo(() => {
    if (!historyRaw) return [];
    return historyRaw.filter((row) => row.resultImageUrl !== imageUrlA && !row.dismissedAt);
  }, [historyRaw, imageUrlA]);
  const dismissedHistory = useMemo(() => {
    if (!historyRaw) return [];
    return historyRaw.filter((row) => row.resultImageUrl !== imageUrlA && !!row.dismissedAt);
  }, [historyRaw, imageUrlA]);

  // ─── Action handlers ─────────────────────────────────────────────────────────
  const handleRestore = (imageUrl: string) => {
    restoreMutation.mutate({ conceptId, imageUrl });
  };

  const handleEditFromHistory = async (imageUrl: string) => {
    // Restore first (studio edits slot A), then navigate
    restoreMutation.mutate(
      { conceptId, imageUrl },
      { onSuccess: () => navigate(`/${slug}/design-studio?conceptId=${conceptId}`) }
    );
  };

  const handleMockupFromHistory = async (imageUrl: string) => {
    // Restore first (mockup compositor uses slot A), then navigate
    restoreMutation.mutate(
      { conceptId, imageUrl },
      { onSuccess: () => navigate(`/${slug}/mockups?conceptId=${conceptId}`) }
    );
  };

  // ─── Relative time helper ────────────────────────────────────────────────────
  const relativeTime = (date: Date | string) => {
    const ms = Date.now() - new Date(date).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  };

  // ─── No design yet ──────────────────────────────────────────────────────────
  if (!displayUrl) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          Design
        </span>
        <span className="text-[11px] bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 px-2.5 py-0.5 rounded-md">
          1 best · faithful to the concept
        </span>
      </div>

      {/* Live design + controls */}
      <div className="flex gap-4 flex-wrap">
        {/* Thumbnail */}
        <Dialog>
          <DialogTrigger asChild>
            <button className="relative w-[180px] shrink-0 aspect-square rounded-lg border border-border overflow-hidden cursor-zoom-in group hover:border-primary/50 transition-colors">
              <img
                src={displayUrl}
                alt={`${conceptName} — live design`}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
              />
              <Badge className="absolute top-2 left-2 bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] gap-1 pointer-events-none">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 inline-block" />
                Live
              </Badge>
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl p-2 bg-card">
            <img src={displayUrl} alt={`${conceptName} — full size`} className="w-full rounded-lg" />
          </DialogContent>
        </Dialog>

        {/* Meta + controls */}
        <div className="flex-1 min-w-[240px] flex flex-col">
          <span className="text-xs text-muted-foreground">Current design</span>
          <span className="text-sm mt-0.5">
            Style: <span className="font-medium">{currentStyle || "—"}</span>
          </span>

          {/* Style selector + Regenerate */}
          <div className="flex gap-2 mt-3">
            <select
              value={regenStyle}
              onChange={(e) => setRegenStyle(e.target.value)}
              className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm min-w-0"
              disabled={regenerateMutation.isPending}
            >
              {styleOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-sm gap-1.5 shrink-0"
              disabled={regenerateMutation.isPending}
              onClick={() => regenerateMutation.mutate({ conceptId, style: regenStyle })}
            >
              {regenerateMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Regenerate
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
            <RefreshCw className="h-3 w-3" />
            One image, headline rendered · replaces live, old one drops into history
          </span>

          {/* Action buttons */}
          <div className="flex gap-2 mt-auto pt-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => navigate(`/${slug}/design-studio?conceptId=${conceptId}`)}
            >
              <Paintbrush className="h-3.5 w-3.5" />
              Edit in studio
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => navigate(`/${slug}/mockups?conceptId=${conceptId}`)}
            >
              <Shirt className="h-3.5 w-3.5" />
              Make mockup
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => navigate(`/${slug}/listings`)}
            >
              <ShoppingBag className="h-3.5 w-3.5" />
              Push to Shopify
            </Button>
            {!isDismissed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 border-amber-200"
                  onClick={() => { setShowDesignDismissChips(true); setShowConceptDismissChips(false); }}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Dismiss Design
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                  onClick={() => { setShowConceptDismissChips(true); setShowDesignDismissChips(false); }}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Dismiss Concept
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border-emerald-200"
                disabled={undismissMutation.isPending}
                onClick={() => undismissMutation.mutate({ conceptId })}
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo dismiss
              </Button>
            )}
          </div>

          {/* Dismiss DESIGN reason chips (generation-level) */}
          {showDesignDismissChips && (
            <div className="mt-3 p-3 rounded-lg border border-amber-200 bg-amber-50/50 space-y-2">
              <p className="text-xs font-medium text-amber-800">Why dismiss this design?</p>
              <div className="flex flex-wrap gap-1.5">
                {DISMISS_TAGS.map((tag) => (
                  <button
                    key={tag.key}
                    onClick={() => toggleDesignTag(tag.key)}
                    className={`px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                      designTags.includes(tag.key)
                        ? "bg-amber-600 text-white border-amber-600"
                        : "bg-white text-amber-700 border-amber-200 hover:border-amber-400"
                    }`}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                  disabled={designTags.length === 0 || dismissDesignMutation.isPending}
                  onClick={() => dismissDesignMutation.mutate({ conceptId, tags: designTags })}
                >
                  {dismissDesignMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  Confirm dismiss design
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => { setShowDesignDismissChips(false); setDesignTags([]); }}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Dismisses only this design image — the concept stays active and you can regenerate a new one.
              </p>
            </div>
          )}

          {/* Dismiss CONCEPT reason chips (concept-level) */}
          {showConceptDismissChips && (
            <div className="mt-3 p-3 rounded-lg border border-red-200 bg-red-50/50 space-y-2">
              <p className="text-xs font-medium text-red-800">Why dismiss this entire concept?</p>
              <div className="flex flex-wrap gap-1.5">
                {DISMISS_TAGS.map((tag) => (
                  <button
                    key={tag.key}
                    onClick={() => toggleConceptTag(tag.key)}
                    className={`px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                      conceptTags.includes(tag.key)
                        ? "bg-red-600 text-white border-red-600"
                        : "bg-white text-red-700 border-red-200 hover:border-red-400"
                    }`}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={conceptTags.length === 0 || dismissConceptMutation.isPending}
                  onClick={() => dismissConceptMutation.mutate({ conceptId, tags: conceptTags })}
                >
                  {dismissConceptMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  Confirm dismiss concept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => { setShowConceptDismissChips(false); setConceptTags([]); }}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Removes the entire concept from active views AND teaches the next scan to avoid it.
              </p>
            </div>
          )}

          {/* Dismissed badge */}
          {isDismissed && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="destructive" className="text-[10px]">Dismissed</Badge>
              {rejectionTags?.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] border-red-200 text-red-600">
                  {DISMISS_TAGS.find((t) => t.key === tag)?.label || tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Previous versions strip */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <History className="h-4 w-4 text-muted-foreground" />
            Previous versions
            {history.length > 0 && (
              <span className="text-muted-foreground font-normal"> · {history.length}</span>
            )}
          </span>
          {history.length > 0 && (
            <span className="text-[11px] text-muted-foreground">newest first</span>
          )}
        </div>

        {historyLoading ? (
          <div className="grid grid-cols-4 gap-2.5">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-3">
            Every regenerate snapshots the prior design here — restore, edit, or turn any into a mockup.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
            {history.map((row) => (
              <div
                key={row.id}
                className="rounded-lg border border-border overflow-hidden bg-background"
              >
                {/* Thumbnail */}
                <div className="aspect-square bg-muted/30 relative">
                  <img
                    src={row.resultImageUrl}
                    alt="Previous version"
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
                {/* Meta + actions */}
                <div className="p-2 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground truncate">
                    {(row.instruction || "Generation").replace("Generation — ", "")} · {relativeTime(row.createdAt)}
                  </p>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 flex-1"
                      title="Restore as live"
                      disabled={restoreMutation.isPending}
                      onClick={() => handleRestore(row.resultImageUrl)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 flex-1"
                      title="Edit in studio"
                      disabled={restoreMutation.isPending}
                      onClick={() => handleEditFromHistory(row.resultImageUrl)}
                    >
                      <Paintbrush className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 flex-1"
                      title="Make mockup"
                      disabled={restoreMutation.isPending}
                      onClick={() => handleMockupFromHistory(row.resultImageUrl)}
                    >
                      <Shirt className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 flex-1 text-muted-foreground hover:text-red-500 hover:border-red-300"
                      title="Dismiss this version"
                      disabled={dismissGenerationMutation.isPending}
                      onClick={() => { setDismissingVersionId(row.id); setVersionTags([]); }}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {/* Per-version dismiss chip selector */}
                  {dismissingVersionId === row.id && (
                    <div className="mt-1.5 p-2 bg-red-50 dark:bg-red-950/30 rounded-md space-y-2">
                      <p className="text-[10px] text-red-700 dark:text-red-300 font-medium">Why dismiss this version?</p>
                      <div className="flex flex-wrap gap-1">
                        {DISMISS_TAGS.map((t) => (
                          <button
                            key={t.key}
                            onClick={() => toggleVersionTag(t.key)}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                              versionTags.includes(t.key)
                                ? "bg-red-100 border-red-300 text-red-800 dark:bg-red-900/50 dark:border-red-700 dark:text-red-200"
                                : "bg-background border-border text-muted-foreground hover:border-red-300"
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 text-[10px] px-2"
                          disabled={versionTags.length === 0 || dismissGenerationMutation.isPending}
                          onClick={() => dismissGenerationMutation.mutate({ revisionId: row.id, tags: versionTags })}
                        >
                          {dismissGenerationMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2"
                          onClick={() => setDismissingVersionId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Dismissed versions (collapsed) */}
        {dismissedHistory.length > 0 && (
          <details className="mt-3">
            <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
              Dismissed versions ({dismissedHistory.length})
            </summary>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 mt-2">
              {dismissedHistory.map((row) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-red-200 dark:border-red-900/50 overflow-hidden bg-red-50/50 dark:bg-red-950/20 opacity-60"
                >
                  <div className="aspect-square bg-muted/30 relative">
                    <img
                      src={row.resultImageUrl}
                      alt="Dismissed version"
                      className="w-full h-full object-cover grayscale"
                      loading="lazy"
                    />
                  </div>
                  <div className="p-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground truncate">
                      {relativeTime(row.createdAt)}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] w-full"
                      disabled={undismissGenerationMutation.isPending}
                      onClick={() => undismissGenerationMutation.mutate({ revisionId: row.id })}
                    >
                      <Undo2 className="h-3 w-3 mr-1" /> Undo dismiss
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
