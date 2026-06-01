import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Trophy, Crown, ChevronDown, Camera, ChevronRight, ExternalLink, Trash2, Wand2, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ColorSwatch } from "./ColorSwatch";
import { TrendBar } from "./TrendBar";
import { HumorFrameworkTag } from "./HumorFrameworkTag";
import { EtsyValidationBadge } from "./EtsyValidationBadge";
import { DesignImagePair } from "./DesignImagePair";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";

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
  onDelete,
  onGenerateImage,
}: ConceptCardProps) {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const [expanded, setExpanded] = useState(false);
  const [whyExpanded, setWhyExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const utils = trpc.useUtils();
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

  const imageCount = [imageUrlA, imageUrlB, imageUrlC].filter(Boolean).length;

  const winnerBorder = isWinner
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
            {/* Winner badge — large gold treatment */}
            {isWinner && (
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
            {!isWinner && globalRank && (
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
            <CardTitle className="text-base font-semibold text-foreground">{conceptName}</CardTitle>
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
            {onGenerateImage && !imageUrlA && !imageUrlB && !imageUrlC && (
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
        {isWinner && topScore && (
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
                  <p className="text-xs text-muted-foreground italic mt-1">{trendRationale}</p>
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

        {/* AI-generated design images — 3 variations for winners */}
        {(showImages || (compact && expanded)) && (imageUrlA || imageUrlB || imageUrlC) && (
          <DesignImagePair
            imageUrlA={imageUrlA ?? null}
            imageUrlB={imageUrlB ?? null}
            imageUrlC={imageUrlC}
            imagePromptA={imagePromptA ?? null}
            imagePromptB={imagePromptB ?? null}
            imagePromptC={imagePromptC}
            conceptName={conceptName}
          />
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
    </Card>
  );
}
