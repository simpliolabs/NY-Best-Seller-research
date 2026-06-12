import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ColorSwatch } from "@/components/ColorSwatch";
import { TrendBar } from "@/components/TrendBar";
import { ConceptCard } from "@/components/ConceptCard";
import { NicheResearchPanel } from "@/components/NicheResearchPanel";
import { ForumSignalsBadge, ForumSignalsDetail } from "@/components/ForumSignalsBadge";
import { BookTrendCharts } from "@/components/BookTrendCharts";
import { ImageThumbnail } from "@/components/ImageThumbnail";
import { ImageLightbox } from "@/components/ImageLightbox";
import {
  ArrowLeft,
  BookOpen,
  MapPin,
  Palette,
  Users,
  TrendingUp,
  TrendingDown,
  ArrowRight as ArrowRightIcon,
  Sparkles,
  Flame,
  Trophy,
  Crown,
  RefreshCw,
  BarChart3,
  Layers,
  MessageSquare,
  ChevronDown,
  Globe,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "sonner";

type Tab = "concepts" | "analytics" | "research";

// ─── World Bible Panel ────────────────────────────────────────────────────

type WorldBible = {
  illustratorStyle?: string;
  keyVisualEnvironments?: string[];
  keyObjects?: string[];
  lightingSignature?: string;
  textureLanguage?: string;
  typographyNative?: string;
  emotionalTone?: string;
  colorAnchors?: string[];
};

function WorldBibleSection({
  icon: Icon,
  title,
  color,
  children,
  defaultOpen = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  color: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center justify-between w-full p-3 rounded-lg bg-secondary/50 hover:bg-secondary/80 transition-colors group">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-md ${color}`}>
            <Icon className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-medium text-foreground">{title}</span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 px-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function WorldBiblePanel({ worldBible }: { worldBible: WorldBible }) {
  const wb = worldBible;
  return (
    <Card className="border border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-violet-500" />
          <CardTitle className="text-sm font-semibold text-foreground">World Bible</CardTitle>
          <Badge variant="outline" className="text-xs text-violet-600 border-violet-300">Stage 2 Extract</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Visual universe extracted from the book's IP — used to anchor image generation prompts.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {wb.illustratorStyle && (
          <WorldBibleSection icon={Palette} title="Illustrator Style" color="bg-violet-500" defaultOpen>
            <p className="text-sm text-foreground/80 leading-relaxed">{wb.illustratorStyle}</p>
          </WorldBibleSection>
        )}
        {wb.emotionalTone && (
          <WorldBibleSection icon={Sparkles} title="Emotional Tone" color="bg-pink-500">
            <p className="text-sm text-foreground/80 leading-relaxed">{wb.emotionalTone}</p>
          </WorldBibleSection>
        )}
        {wb.lightingSignature && (
          <WorldBibleSection icon={Flame} title="Lighting Signature" color="bg-amber-500">
            <p className="text-sm text-foreground/80 leading-relaxed">{wb.lightingSignature}</p>
          </WorldBibleSection>
        )}
        {wb.textureLanguage && (
          <WorldBibleSection icon={Layers} title="Texture Language" color="bg-stone-500">
            <p className="text-sm text-foreground/80 leading-relaxed">{wb.textureLanguage}</p>
          </WorldBibleSection>
        )}
        {wb.typographyNative && (
          <WorldBibleSection icon={BookOpen} title="Typography Native" color="bg-blue-500">
            <p className="text-sm text-foreground/80 leading-relaxed">{wb.typographyNative}</p>
          </WorldBibleSection>
        )}
        {wb.colorAnchors && wb.colorAnchors.length > 0 && (
          <WorldBibleSection icon={Palette} title="Color Anchors" color="bg-emerald-500">
            <div className="flex flex-wrap gap-1.5">
              {wb.colorAnchors.map((c: string, i: number) => (
                <Badge key={i} variant="outline" className="text-xs">{c}</Badge>
              ))}
            </div>
          </WorldBibleSection>
        )}
        {wb.keyVisualEnvironments && wb.keyVisualEnvironments.length > 0 && (
          <WorldBibleSection icon={MapPin} title="Key Visual Environments" color="bg-teal-500">
            <ul className="space-y-1">
              {wb.keyVisualEnvironments.map((e: string, i: number) => (
                <li key={i} className="text-sm text-foreground/80 flex items-start gap-1.5">
                  <span className="text-muted-foreground mt-0.5">•</span>{e}
                </li>
              ))}
            </ul>
          </WorldBibleSection>
        )}
        {wb.keyObjects && wb.keyObjects.length > 0 && (
          <WorldBibleSection icon={Users} title="Key Objects &amp; Artifacts" color="bg-orange-500">
            <div className="flex flex-wrap gap-1.5">
              {wb.keyObjects.map((o: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">{o}</Badge>
              ))}
            </div>
          </WorldBibleSection>
        )}
      </CardContent>
    </Card>
  );
}

/** Safely parse forumSignals — it may arrive as a JSON string or already as an object */
function parseForumSignals(raw: unknown): any | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

export default function BookDetail() {
  const [match, params] = useRoute("/:slug/book/:id");
  const [, setLocation] = useLocation();
  const { activeWorkspace } = useWorkspace();
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const bookId = match ? parseInt(params.id, 10) : 0;
  const [activeTab, setActiveTab] = useState<Tab>("concepts");

  // Lightbox state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxConcept, setLightboxConcept] = useState<any>(null);

  const workspaceId = activeWorkspace?.id ?? "";
  const { data, isLoading, refetch } = trpc.books.getById.useQuery(
    { bookId, workspaceId },
    { enabled: bookId > 0 && !!workspaceId }
  );

  const utils = trpc.useUtils();

  const deleteConceptMut = trpc.revision.deleteConcept.useMutation({
    onSuccess: () => {
      toast.success("Concept deleted");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const generateImageMut = trpc.concepts.generateSingleImage.useMutation({
    onSuccess: (res) => {
      if (res.success) {
        toast.success("Images generated!");
        refetch();
      } else {
        toast.error(res.message || "Image generation failed");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const refreshMutation = trpc.books.refresh.useMutation({
    onSuccess: () => {
      // Refetch book data after refresh completes
      setTimeout(() => refetch(), 1000);
    },
  });

  const { data: refreshStatus } = trpc.books.getRefreshStatus.useQuery(
    { bookId },
    { enabled: bookId > 0 && refreshMutation.isPending, refetchInterval: 2000 }
  );

  if (isLoading || !match) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const book = data?.book;
  const concepts = data?.concepts ?? [];
  const nicheResearch = data?.nicheResearch;
  const marketValidations = data?.marketValidations ?? [];

  const mvByConceptId = new Map(
    marketValidations.map((mv: any) => [mv.conceptId, mv])
  );

  if (!book) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setLocation(`/${params?.slug ?? ""}`)} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">{isNicheWorkspace ? "Signal not found." : "Book not found."}</p>
      </div>
    );
  }

  // Separate winners from other concepts, then new refreshes
  const winnerConcepts = [...concepts]
    .filter((c: any) => c.isWinner)
    .sort((a: any, b: any) => (a.globalRank ?? 999) - (b.globalRank ?? 999));
  const refreshConcepts = [...concepts]
    .filter((c: any) => !c.isWinner && c.refreshSource === "book_refresh")
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const otherConcepts = [...concepts]
    .filter((c: any) => !c.isWinner && c.refreshSource !== "book_refresh")
    .sort((a: any, b: any) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

  const handleRefresh = () => {
    if (!refreshMutation.isPending) {
      refreshMutation.mutate({ bookId });
    }
  };

  const tabs = [
    { id: "concepts" as Tab, label: "Concepts", icon: Layers, count: concepts.length },
    { id: "analytics" as Tab, label: "Analytics", icon: BarChart3 },
    { id: "research" as Tab, label: "Research", icon: MessageSquare },
  ];

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => window.history.back()} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> {isNicheWorkspace ? "Back to Signals" : "Back"}
        </Button>

        {/* Refresh button */}
        <Button
          onClick={handleRefresh}
          disabled={refreshMutation.isPending}
          variant="outline"
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
          {refreshMutation.isPending
            ? refreshStatus?.status ?? "Refreshing..."
            : (isNicheWorkspace ? "Refresh This Signal" : "Refresh This Book")
          }
        </Button>
      </div>

      {/* Refresh progress banner */}
      {refreshMutation.isPending && refreshStatus && (
        <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
          <CardContent className="py-3 flex items-center gap-3">
            <div className="h-2 flex-1 bg-blue-100 dark:bg-blue-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${refreshStatus.progress}%` }}
              />
            </div>
            <span className="text-sm text-blue-700 dark:text-blue-300 whitespace-nowrap">
              {refreshStatus.status}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Refresh result banner */}
      {refreshMutation.isSuccess && !refreshMutation.isPending && (
        <Card className="border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800">
          <CardContent className="py-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <Sparkles className="h-4 w-4" />
            {refreshMutation.data?.message}
          </CardContent>
        </Card>
      )}

      {/* Book / Signal Profile */}
      <Card className="border shadow-sm">
        <CardHeader>
          <div className="flex items-start gap-4">
            {book.coverUrl && (
              <img
                src={book.coverUrl}
                alt={book.title}
                className="w-24 h-36 object-cover rounded-md shadow-md shrink-0"
              />
            )}
            <div className="space-y-2 min-w-0">
              {isNicheWorkspace && (
                <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-300 text-[11px]">NICHE SIGNAL</Badge>
              )}
              <CardTitle className="text-xl text-foreground">{book.title}</CardTitle>
              <p className="text-sm text-muted-foreground">{book.author}</p>
              {isNicheWorkspace && (
                <p className="text-xs text-muted-foreground mt-1">
                  This is the source trend found in the community — the concepts below are shirt ideas generated from it. A winner may riff on a different angle of the same niche.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {book.trendDirection === "up" && (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-300 gap-1">
                    <TrendingUp className="h-3 w-3" />
                    Rising{book.scoreDelta != null ? ` (+${book.scoreDelta})` : ""}
                  </Badge>
                )}
                {book.trendDirection === "down" && (
                  <Badge className="bg-red-100 text-red-700 border-red-300 gap-1">
                    <TrendingDown className="h-3 w-3" />
                    Falling{book.scoreDelta != null ? ` (${book.scoreDelta})` : ""}
                  </Badge>
                )}
                {book.trendDirection === "stable" && (
                  <Badge className="bg-blue-100 text-blue-700 border-blue-300 gap-1">
                    <ArrowRightIcon className="h-3 w-3" />
                    Stable
                  </Badge>
                )}
                {book.trendDirection === "new" && (
                  <Badge className="bg-amber-100 text-amber-700 border-amber-300 gap-1">
                    <Sparkles className="h-3 w-3" />
                    New Entry
                  </Badge>
                )}
                {(book.streakCount ?? 0) > 1 && (
                  <Badge variant="outline" className="gap-1">
                    <Flame className="h-3 w-3 text-orange-500" />
                    {book.streakCount} consecutive runs
                  </Badge>
                )}
                {book.subgenre && <Badge variant="secondary">{book.subgenre}</Badge>}
                {book.mood && <Badge variant="outline">{book.mood}</Badge>}
                <Badge variant="outline">Rank #{book.rank}</Badge>
                <Badge variant="outline">{book.weeksOnList} weeks on list</Badge>
                {winnerConcepts.length > 0 && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-300 gap-1">
                    <Trophy className="h-3 w-3" />
                    {winnerConcepts.length} winning concept{winnerConcepts.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>

              {/* Winner image thumbnails row */}
              {winnerConcepts.length > 0 && (
                <div className="flex gap-2 mt-3">
                  {winnerConcepts.map((c: any) => (
                    <ImageThumbnail
                      key={c.id}
                      src={c.productionUrlA || c.imageUrlA || c.productionUrlB || c.imageUrlB || c.productionUrlC || c.imageUrlC}
                      alt={c.conceptName}
                      size={56}
                      badge={`#${c.globalRank}`}
                      onClick={() => {
                        setLightboxConcept(c);
                        setLightboxOpen(true);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {book.synopsis && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5" /> Synopsis
              </h3>
              <p className="text-sm text-foreground/80 leading-relaxed">{book.synopsis}</p>
            </div>
          )}
          {book.fanCulture && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Fan Culture
              </h3>
              <p className="text-sm text-foreground/80 leading-relaxed">{book.fanCulture}</p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              {book.setting && (
                <div className="flex items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm text-foreground">{book.setting}</span>
                </div>
              )}
              {book.dominantColors && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    <Palette className="h-3 w-3" /> Color Palette
                  </p>
                  <ColorSwatch colors={book.dominantColors} size="md" />
                </div>
              )}
              {book.visualMotifs && book.visualMotifs.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Visual Motifs</p>
                  <div className="flex flex-wrap gap-1">
                    {book.visualMotifs.map((m: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">{m}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {book.typographyStyle && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Typography:</span>
                  <span className="text-foreground">{book.typographyStyle}</span>
                </div>
              )}
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">Trend Breakdown</h3>
              <TrendBar label="Social Momentum" score={book.socialMomentum ?? 0} rationale={book.socialRationale} color="bg-chart-1" />
              <TrendBar label="Design Novelty" score={book.designNovelty ?? 0} rationale={book.designRationale} color="bg-chart-2" />
              <TrendBar label="Audience Size" score={book.audienceSize ?? 0} rationale={book.audienceRationale} color="bg-chart-3" />
              <div className="pt-2 border-t border-border">
                <TrendBar label="Total Score" score={book.trendScoreTotal ?? 0} maxScore={300} color="bg-primary" />
                {book.previousTrendScore != null && (
                  <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                    <p>Previous score: {book.previousTrendScore}/300</p>
                    {book.previousRank != null && <p>Previous rank: #{book.previousRank}</p>}
                    {book.scoreDelta != null && (
                      <p className={book.scoreDelta > 0 ? "text-emerald-600" : book.scoreDelta < 0 ? "text-red-600" : ""}>
                        Delta: {book.scoreDelta > 0 ? "+" : ""}{book.scoreDelta} points
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {"count" in tab && tab.count !== undefined && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-muted font-mono">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === "concepts" && (
        <>
          {/* WINNER CONCEPTS — shown first with gold styling */}
          {winnerConcepts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Crown className="h-5 w-5 text-amber-500" />
                <h2 className="text-lg font-bold text-foreground">
                  {isNicheWorkspace ? `Winning Concepts — generated from this signal (${winnerConcepts.length})` : `Winning Concepts (${winnerConcepts.length})`}
                </h2>
              </div>
              <div className="space-y-4">
                {winnerConcepts.map((c: any) => {
                  const mv = mvByConceptId.get(c.id);
                  return (
                    <ConceptCard
                      key={c.id}
                      id={c.id}
                      conceptName={c.conceptName}
                      format={c.format}
                      style={c.style}
                      headline={c.headline}
                      subtext={c.subtext}
                      colorPalette={c.colorPalette}
                      layoutDescription={c.layoutDescription}
                      fontSuggestion={c.fontSuggestion}
                      copyrightSafe={c.copyrightSafe}
                      isFavorite={c.isFavorite}
                      humorFramework={c.humorFramework}
                      trendScore={c.trendScore}
                      trendRationale={c.trendRationale}
                      socialMomentum={book.socialMomentum}
                      designNovelty={book.designNovelty}
                      audienceSize={book.audienceSize}
                      imageUrlA={c.imageUrlA}
                      imageUrlB={c.imageUrlB}
                      imageUrlC={c.imageUrlC}
                      productionUrlA={c.productionUrlA}
                      productionUrlB={c.productionUrlB}
                      productionUrlC={c.productionUrlC}
                      imagePromptA={c.imagePromptA}
                      imagePromptB={c.imagePromptB}
                      imagePromptC={c.imagePromptC}
                      isWinner={true}
                      globalRank={c.globalRank}
                      marketValidation={mv ?? null}
                      showImages={true}
                      refreshSource={c.refreshSource}
                      signalTags={Array.isArray(c.signalTags) ? c.signalTags : []}
                      onDelete={(id) => deleteConceptMut.mutate({ conceptId: id })}
                      onGenerateImage={(id) => generateImageMut.mutate({ conceptId: id })}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* REFRESHED CONCEPTS — new concepts from per-book refresh */}
          {refreshConcepts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <RefreshCw className="h-5 w-5 text-blue-500" />
                <h2 className="text-lg font-bold text-foreground">
                  Refreshed Concepts ({refreshConcepts.length})
                </h2>
                <Badge className="bg-blue-100 text-blue-700 border-blue-300 text-xs">New</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {refreshConcepts.map((c: any) => {
                  const mv = mvByConceptId.get(c.id);
                  return (
                    <ConceptCard
                      key={c.id}
                      id={c.id}
                      conceptName={c.conceptName}
                      format={c.format}
                      style={c.style}
                      headline={c.headline}
                      subtext={c.subtext}
                      colorPalette={c.colorPalette}
                      layoutDescription={c.layoutDescription}
                      fontSuggestion={c.fontSuggestion}
                      copyrightSafe={c.copyrightSafe}
                      isFavorite={c.isFavorite}
                      humorFramework={c.humorFramework}
                      trendScore={c.trendScore}
                      trendRationale={c.trendRationale}
                      imageUrlA={c.imageUrlA}
                      imageUrlB={c.imageUrlB}
                      imageUrlC={c.imageUrlC}
                      productionUrlA={c.productionUrlA}
                      productionUrlB={c.productionUrlB}
                      productionUrlC={c.productionUrlC}
                      imagePromptA={c.imagePromptA}
                      imagePromptB={c.imagePromptB}
                      imagePromptC={c.imagePromptC}
                      isWinner={false}
                      globalRank={c.globalRank}
                      marketValidation={mv ?? null}
                      showImages={true}
                      compact={true}
                      refreshSource={c.refreshSource}
                      signalTags={Array.isArray(c.signalTags) ? c.signalTags : []}
                      onDelete={(id) => deleteConceptMut.mutate({ conceptId: id })}
                      onGenerateImage={(id) => generateImageMut.mutate({ conceptId: id })}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Other Concepts */}
          {otherConcepts.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 text-foreground">
                {isNicheWorkspace ? `Other Concepts from this signal (${otherConcepts.length})` : `Other Concepts (${otherConcepts.length})`}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {otherConcepts.map((c: any) => {
                  const mv = mvByConceptId.get(c.id);
                  return (
                    <ConceptCard
                      key={c.id}
                      id={c.id}
                      conceptName={c.conceptName}
                      format={c.format}
                      style={c.style}
                      headline={c.headline}
                      subtext={c.subtext}
                      colorPalette={c.colorPalette}
                      layoutDescription={c.layoutDescription}
                      fontSuggestion={c.fontSuggestion}
                      copyrightSafe={c.copyrightSafe}
                      isFavorite={c.isFavorite}
                      humorFramework={c.humorFramework}
                      trendScore={c.trendScore}
                      trendRationale={c.trendRationale}
                      imageUrlA={c.imageUrlA}
                      imageUrlB={c.imageUrlB}
                      imageUrlC={c.imageUrlC}
                      productionUrlA={c.productionUrlA}
                      productionUrlB={c.productionUrlB}
                      productionUrlC={c.productionUrlC}
                      imagePromptA={c.imagePromptA}
                      imagePromptB={c.imagePromptB}
                      imagePromptC={c.imagePromptC}
                      isWinner={false}
                      globalRank={c.globalRank}
                      marketValidation={mv ?? null}
                      showImages={true}
                      compact={true}
                      refreshSource={c.refreshSource}
                      signalTags={Array.isArray(c.signalTags) ? c.signalTags : []}
                      onDelete={(id) => deleteConceptMut.mutate({ conceptId: id })}
                      onGenerateImage={(id) => generateImageMut.mutate({ conceptId: id })}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === "analytics" && book.isbn && (
        <BookTrendCharts isbn={book.isbn} bookTitle={book.title} />
      )}

      {activeTab === "analytics" && !book.isbn && (
        <Card className="p-8 text-center text-muted-foreground">
          <p>No ISBN available for this book. Analytics requires ISBN for cross-run tracking.</p>
        </Card>
      )}

      {activeTab === "research" && (
        <>
          {/* World Bible Panel */}
          {book.worldBible && (
            <WorldBiblePanel worldBible={book.worldBible as any} />
          )}

          {/* Niche Research — primary content with cross-source signal badges */}
          <NicheResearchPanel
            fanConversations={nicheResearch?.fanConversations ?? null}
            designStyles={nicheResearch?.designStyles ?? null}
            whiteSpace={nicheResearch?.whiteSpace ?? null}
            bookTitle={book.title}
            forumSignals={parseForumSignals(book.forumSignals)}
          />

          {/* Forum source detail cards — always shown when data exists */}
          {book.forumSignals && (
            <Card className="border border-border/50 mt-4">
              <CardContent className="pt-5 space-y-4">
                <ForumSignalsBadge forumSignals={parseForumSignals(book.forumSignals)} />
                <ForumSignalsDetail forumSignals={parseForumSignals(book.forumSignals)} />
              </CardContent>
            </Card>
          )}

          {!book.forumSignals && !nicheResearch && (
            <Card className="p-8 text-center text-muted-foreground mt-4">
              <p>No research data yet. Run a pipeline to scrape forum signals for this book.</p>
            </Card>
          )}
        </>
      )}

      {/* Lightbox */}
      {lightboxConcept && (
        <ImageLightbox
          isOpen={lightboxOpen}
          onClose={() => { setLightboxOpen(false); setLightboxConcept(null); }}
          conceptId={lightboxConcept.id}
          conceptName={lightboxConcept.conceptName}
          images={{
            A: lightboxConcept.productionUrlA || lightboxConcept.imageUrlA,
            B: lightboxConcept.productionUrlB || lightboxConcept.imageUrlB,
            C: lightboxConcept.productionUrlC || lightboxConcept.imageUrlC,
          }}
          detail={{
            headline: lightboxConcept.headline,
            subtext: lightboxConcept.subtext,
            layoutDescription: lightboxConcept.layoutDescription,
            fontSuggestion: lightboxConcept.fontSuggestion,
            colorPalette: lightboxConcept.colorPalette,
            format: lightboxConcept.format,
            style: lightboxConcept.style,
            humorFramework: lightboxConcept.humorFramework,
            trendScore: lightboxConcept.trendScore,
            isWinner: lightboxConcept.isWinner,
            globalRank: lightboxConcept.globalRank,
            bookTitle: book?.title ?? null,
            bookAuthor: book?.author ?? null,
            bookId: book?.id ?? null,
            imagePromptA: lightboxConcept.imagePromptA,
            imagePromptB: lightboxConcept.imagePromptB,
            imagePromptC: lightboxConcept.imagePromptC,
            signalTags: Array.isArray(lightboxConcept.signalTags) ? lightboxConcept.signalTags : [],
            sourcePhrase: lightboxConcept.sourcePhrase ?? null,
            bookSocialMomentum: book?.socialMomentum ?? null,
            bookSocialRationale: book?.socialRationale ?? null,
            bookDesignNovelty: book?.designNovelty ?? null,
            bookDesignRationale: book?.designRationale ?? null,
            bookAudienceSize: book?.audienceSize ?? null,
            bookAudienceRationale: book?.audienceRationale ?? null,
          }}
        />
      )}
    </div>
  );
}
