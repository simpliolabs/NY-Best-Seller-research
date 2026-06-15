import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Trophy, Crown, ChevronDown, Camera, ChevronRight, ExternalLink, Trash2, Wand2, Loader2, Paintbrush, Shirt, Pencil, XCircle, RotateCcw } from "lucide-react";
import { Link } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ColorSwatch } from "./ColorSwatch";
import { TrendBar } from "./TrendBar";
import { HumorFrameworkTag } from "./HumorFrameworkTag";
import { EtsyValidationBadge } from "./EtsyValidationBadge";
import { ConceptDesignPanel } from "./ConceptDesignPanel";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ─── Rejection tags (must match backend TAG_DIRECTIVE keys) ──────────────────

const REJECTION_TAGS = [
  { id: "too_dark", label: "Too dark / heavy" },
  { id: "too_similar", label: "Too similar to the others" },
  { id: "wrong_style", label: "Wrong / cartoonish style" },
  { id: "off_brand", label: "Off-brand / off-niche" },
  { id: "weak_humor", label: "Weak hook / not funny" },
  { id: "bad_colors", label: "Bad colors" },
  { id: "too_generic", label: "Too generic" },
  { id: "poor_composition", label: "Weak composition" },
  { id: "bad_subject", label: "Weak subject" },
] as const;

type RejectionTagId = (typeof REJECTION_TAGS)[number]["id"];

interface MarketValidation {
  saturationLevel: string | null;
  etsyListingCount: number | null;
  avgPrice: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  topFavorites: number | null;
  searchKeywords: string | null;
}

interface ConceptCardProps {
  id: number;
  conceptName: string;
  format: string;
  style: string;
  headline: string | null;
  subtext: string | null;
  colorPalette: string[] | null;
  layoutDescription: string | null;
  fontSuggestion: string | null;
  copyrightSafe: boolean;
  isFavorite: boolean;
  bookId?: number | null;
  bookTitle?: string | null;
  bookAuthor?: string | null;
  humorFramework?: string | null;
  trendScore?: number | null;
  trendRationale?: string | null;
  socialMomentum?: number | null;
  designNovelty?: number | null;
  audienceSize?: number | null;
  imageUrlA?: string | null;
  imageUrlB?: string | null;
  imageUrlC?: string | null;
  productionUrlA?: string | null;
  productionUrlB?: string | null;
  productionUrlC?: string | null;
  imagePromptA?: string | null;
  imagePromptB?: string | null;
  imagePromptC?: string | null;
  isWinner?: boolean;
  globalRank?: number | null;
  marketValidation?: MarketValidation | null;
  showImages?: boolean;
  compact?: boolean;
  refreshSource?: string | null;
  signalTags?: string[] | null;
  dismissedAt?: string | Date | null;
  rejectionTags?: string[] | null;
  onDelete?: (id: number) => void;
  onGenerateImage?: (id: number) => void;
}

export function ConceptCard({
  id,
  conceptName,
  format,
  style,
  headline,
  subtext,
  colorPalette,
  layoutDescription,
  fontSuggestion,
  copyrightSafe,
  isFavorite,
  bookId,
  bookTitle,
  bookAuthor,
  humorFramework,
  trendScore,
  trendRationale,
  socialMomentum,
  designNovelty,
  audienceSize,
  imageUrlA,
  imageUrlB,
  imageUrlC,
  productionUrlA,
  productionUrlB,
  productionUrlC,
  imagePromptA,
  imagePromptB,
  imagePromptC,
  isWinner,
  globalRank,
  marketValidation,
  showImages = true,
  compact = false,
  refreshSource,
  signalTags,
  dismissedAt,
  rejectionTags,
  onDelete,
  onGenerateImage,
}: ConceptCardProps) {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const [expanded, setExpanded] = useState(false);
  const [whyExpanded, setWhyExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conceptName);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const renameMutation = trpc.concepts.rename.useMutation({
    onSuccess: () => { toast.success("Renamed"); utils.books.getById.invalidate(); setIsRenaming(false); },
    onError: (err: any) => toast.error(err.message),
  });
  const toggleMutation = trpc.favorites.toggle.useMutation({
    onSuccess: () => {
      utils.favorites.list.invalidate();
      utils.reports.getLatest.invalidate();
      utils.reports.getByRunId.invalidate();
      utils.books.getById.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to toggle favorite");
    },
  });

  const dismissMutation = trpc.concepts.dismiss.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Design dismissed");
      utils.books.getById.invalidate();
      utils.reports.getLatest.invalidate();
      utils.reports.getByRunId.invalidate();
      utils.library.list.invalidate();
      utils.favorites.list.invalidate();
      setDismissDialogOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const undismissMutation = trpc.concepts.undismiss.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Dismiss undone");
      utils.books.getById.invalidate();
      utils.reports.getLatest.invalidate();
      utils.reports.getByRunId.invalidate();
      utils.library.list.invalidate();
      utils.favorites.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // Prefer accepted/production design over raw generated image
  const displayUrlA = productionUrlA || imageUrlA;
  const displayUrlB = productionUrlB || imageUrlB;
  const displayUrlC = productionUrlC || imageUrlC;
  const imageCount = [displayUrlA, displayUrlB, displayUrlC].filter(Boolean).length;

  const isDismissed = !!dismissedAt;

  const winnerBorder = isDismissed
    ? "border-red-300/50 bg-red-50/20 opacity-70"
    : isWinner
      ? "border-amber-400 bg-gradient-to-br from-amber-50/60 to-yellow-50/30 shadow-lg ring-2 ring-amber-300/40"
      : "border-border hover:border-primary/30";

  // For compact cards, show details only when expanded
  const showDetails = !compact || expanded;

  // Compute "Why it won" data
  const scores = [
    { label: "Social Momentum", value: socialMomentum },
    { label: "Design Novelty", value: designNovelty },
    { label: "Audience Size", value: audienceSize },
  ].filter(s => s.value != null) as { label: string; value: number }[];
  const topScore = scores.length > 0 ? scores.reduce((a, b) => a.value > b.value ? a : b) : null;

  return (
    <Card className={`bg-card transition-all ${winnerBorder}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5 min-w-0">
            {/* Dismissed badge */}
            {isDismissed && (
              <Badge variant="outline" className="text-[10px] border-red-400 text-red-500 mb-1">
                Dismissed
              </Badge>
            )}
            {/* Winner badge — large gold treatment */}
            {isWinner && !isDismissed && (
              <div className="flex items-center gap-2 mb-1">
                <div className="flex items-center gap-1.5 bg-gradient-to-r from-amber-400 to-yellow-500 text-white px-3 py-1 rounded-full shadow-sm">
                  {globalRank === 1 ? (
                    <Crown className="h-4 w-4" />
                  ) : (
                    <Trophy className="h-4 w-4" />
                  )}
                  <span className="text-sm font-bold">
                    Winner #{globalRank} of 5
                  </span>
                </div>
                {imageCount > 0 && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                    <Camera className="h-3 w-3" />
                    <span>{imageCount} images generated</span>
                  </div>
                )}
              </div>
            )}
            {!isWinner && !isDismissed && globalRank && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground mb-1">
                #{globalRank}
              </Badge>
            )}
            {/* Refresh source badge */}
            {refreshSource === "book_refresh" && (
              <Badge className="bg-blue-100 text-blue-700 border-blue-300 text-[10px] font-medium mb-1">
                {isNicheWorkspace ? "New — Signal Refresh" : "New — Book Refresh"}
              </Badge>
            )}
            {isRenaming ? (
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const v = renameValue.trim(); if (v && v.length <= 120) renameMutation.mutate({ conceptId: id, name: v }); }}>
                <input autoFocus className="text-sm border rounded px-1.5 py-0.5 bg-background flex-1" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={120} />
                <button type="submit" className="text-xs text-primary font-medium" disabled={renameMutation.isPending}>Save</button>
                <button type="button" className="text-xs text-muted-foreground" onClick={() => { setIsRenaming(false); setRenameValue(conceptName); }}>Cancel</button>
              </form>
            ) : (
              <div className="flex items-center gap-1">
                <CardTitle className="text-base font-semibold text-foreground">{conceptName}</CardTitle>
                <button onClick={() => { setRenameValue(conceptName); setIsRenaming(true); }} className="shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Rename">
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
            {signalTags && signalTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {signalTags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800"
                    title={`Cross-source signal: confirmed in multiple fan forums`}
                  >
                    <span className="text-emerald-500">⚡</span> {tag}
                  </span>
                ))}
              </div>
            )}
            {bookTitle && (
              <p className="text-xs text-muted-foreground">
                {isNicheWorkspace ? "Signal:" : "From:"}{" "}
                {bookId ? (
                  <Link
                    href={`/${slug}/book/${bookId}`}
                    className="text-primary hover:underline font-medium inline-flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {bookTitle}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                ) : (
                  <span className="font-medium">{bookTitle}</span>
                )}
                {bookAuthor ? ` by ${bookAuthor}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!isDismissed && (displayUrlA || displayUrlB || displayUrlC) && (
              <>
                <Link
                  href={`/${slug}/design-studio?conceptId=${id}`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                  title="Edit in Design Studio"
                >
                  <Paintbrush className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href={`/${slug}/mockups?conceptId=${id}`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                  title="Generate product mockups"
                >
                  <Shirt className="h-3.5 w-3.5" />
                </Link>
              </>
            )}
            {!isDismissed && onGenerateImage && !imageUrlA && !imageUrlB && !imageUrlC && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-primary hover:text-primary"
                disabled={isGenerating}
                onClick={() => {
                  setIsGenerating(true);
                  toast.info("Generating images... this takes 15-30 seconds.");
                  onGenerateImage(id);
                }}
                title="Generate image for this concept"
              >
                {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              </Button>
            )}
            {!isDismissed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => toggleMutation.mutate({ conceptId: id })}
                disabled={toggleMutation.isPending}
              >
                <Heart
                  className={`h-4 w-4 transition-colors ${
                    isFavorite ? "fill-red-500 text-red-500" : "text-muted-foreground"
                  }`}
                />
              </Button>
            )}
            {/* Dismiss button — opens reason-chip dialog */}
            {!isDismissed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-red-500"
                onClick={() => setDismissDialogOpen(true)}
                title="Dismiss design"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            )}
            {/* Undo dismiss */}
            {isDismissed && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => undismissMutation.mutate({ conceptId: id })}
                disabled={undismissMutation.isPending}
              >
                {undismissMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Undo dismiss
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm(`Delete "${conceptName}"? This cannot be undone.`)) {
                    onDelete(id);
                  }
                }}
                title="Delete concept"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Rejection tags display (when dismissed) */}
        {isDismissed && rejectionTags && rejectionTags.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Why you dismissed</p>
            <div className="flex flex-wrap gap-1">
              {rejectionTags.map((tag) => {
                const label = REJECTION_TAGS.find((t) => t.id === tag)?.label ?? tag;
                return (
                  <span
                    key={tag}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/40 text-red-400 bg-red-500/10"
                  >
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Tags row — always visible */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="text-xs">{format}</Badge>
          <Badge variant="outline" className="text-xs">{style}</Badge>
          <HumorFrameworkTag framework={humorFramework ?? null} compact />
          {!copyrightSafe && (
            <Badge variant="destructive" className="text-xs">Copyright Risk</Badge>
          )}
          {marketValidation && (
            <EtsyValidationBadge
              saturationLevel={marketValidation.saturationLevel as "low" | "medium" | "high" | null}
              listingCount={marketValidation.etsyListingCount}
              avgPrice={marketValidation.avgPrice}
              minPrice={marketValidation.minPrice}
              maxPrice={marketValidation.maxPrice}
              topFavorites={marketValidation.topFavorites}
              searchKeywords={marketValidation.searchKeywords}
              compact
            />
          )}
        </div>

        {/* Trend score — always visible */}
        {trendScore != null && (
          <TrendBar
            label="Concept Score"
            score={trendScore}
            maxScore={100}
            rationale={trendRationale}
            color={trendScore >= 70 ? "bg-emerald-500" : trendScore >= 40 ? "bg-amber-500" : "bg-red-500"}
          />
        )}

        {/* Headline — always visible */}
        {headline && (
          <p className="text-sm font-medium text-foreground italic">"{headline}"</p>
        )}

        {/* Why It Won — expandable section for winners */}
        {isWinner && !isDismissed && topScore && (
          <div className="border border-amber-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setWhyExpanded(!whyExpanded)}
              className="w-full flex items-center justify-between px-3 py-2 bg-amber-50/50 hover:bg-amber-50 transition-colors text-left"
            >
              <span className="text-xs font-semibold text-amber-800">Why this won</span>
              <ChevronRight className={`h-3.5 w-3.5 text-amber-600 transition-transform duration-200 ${whyExpanded ? "rotate-90" : ""}`} />
            </button>
            {whyExpanded && (
              <div className="px-3 py-2 space-y-1.5 bg-white/50">
                <p className="text-xs text-foreground/80">
                  <span className="font-medium">Top contributing score:</span> {topScore.label} ({topScore.value}/100)
                </p>
                {trendScore != null && (
                  <p className="text-xs text-foreground/80">
                    <span className="font-medium">Total composite:</span> {trendScore} / 300
                  </p>
                )}
                {trendRationale && (
                  <p className="text-xs text-foreground/60 italic">{trendRationale}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Expandable details for compact cards */}
        {showDetails && (
          <>
            {subtext && (
              <p className="text-xs text-muted-foreground">{subtext}</p>
            )}

            {colorPalette && colorPalette.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Color Palette</p>
                <ColorSwatch colors={colorPalette} size="sm" />
              </div>
            )}

            {layoutDescription && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Layout</p>
                <p className="text-xs text-foreground/80 leading-relaxed">{layoutDescription}</p>
              </div>
            )}

            {fontSuggestion && (
              <div className="flex items-center gap-1.5">
                <p className="text-xs text-muted-foreground">Font:</p>
                <p className="text-xs font-medium">{fontSuggestion}</p>
              </div>
            )}
          </>
        )}

        {/* Live design panel — single slot A + history strip */}
        {!isDismissed && (showImages || (compact && expanded)) && displayUrlA && (
          <ConceptDesignPanel
            conceptId={id}
            conceptName={conceptName}
            headline={headline}
            subtext={subtext}
            imageUrlA={imageUrlA ?? null}
            productionUrlA={productionUrlA ?? null}
            currentStyle={style}
          />
        )}

        {/* Helper text for dismiss */}
        {isDismissed && (
          <p className="text-[11px] text-muted-foreground italic">
            Dismiss removes this design from your winners AND teaches the next scan to avoid it — just like the Niche Hunter.
          </p>
        )}

        {/* Expand/Collapse button for compact cards */}
        {compact && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${
                expanded ? "rotate-180" : ""
              }`}
            />
            {expanded ? "Show less" : "Show full details"}
          </Button>
        )}
      </CardContent>

      {/* Dismiss Dialog */}
      <DismissConceptDialog
        open={dismissDialogOpen}
        onClose={() => setDismissDialogOpen(false)}
        onConfirm={(tags) => dismissMutation.mutate({ conceptId: id, tags })}
        isPending={dismissMutation.isPending}
        conceptName={conceptName}
      />
    </Card>
  );
}

// ─── Dismiss Dialog ───────────────────────────────────────────────────────────

function DismissConceptDialog({
  open,
  onClose,
  onConfirm,
  isPending,
  conceptName,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (tags: string[]) => void;
  isPending: boolean;
  conceptName: string;
}) {
  const [selectedTags, setSelectedTags] = useState<RejectionTagId[]>([]);

  const toggleTag = (tag: RejectionTagId) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleConfirm = () => {
    onConfirm(selectedTags);
    setSelectedTags([]);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setSelectedTags([]); } }}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <XCircle className="h-4 w-4 text-red-400" />
            Dismiss Design
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Dismissing <span className="font-medium text-foreground">"{conceptName}"</span> removes it from your winners and teaches the next scan to avoid similar designs.
          </p>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Why are you dismissing it?</p>
            <div className="flex flex-wrap gap-1.5">
              {REJECTION_TAGS.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => toggleTag(tag.id)}
                  className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                    selectedTags.includes(tag.id)
                      ? "border-red-500 text-red-400 bg-red-500/15"
                      : "border-border text-muted-foreground hover:border-red-500/50"
                  }`}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleConfirm}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <XCircle className="h-3.5 w-3.5 mr-1.5" />}
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
