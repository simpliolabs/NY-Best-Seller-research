import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ColorSwatch } from "@/components/ColorSwatch";
import { TrendBar } from "@/components/TrendBar";
import { ConceptCard } from "@/components/ConceptCard";
import {
  Play,
  BookOpen,
  Palette,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Sparkles,
  Crown,
  Trophy,
  Image as ImageIcon,
  Flame,
} from "lucide-react";
import { useLocation } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "sonner";
import { ForumSignalsBadge } from "@/components/ForumSignalsBadge";
import { ImageThumbnail } from "@/components/ImageThumbnail";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useState } from "react";

function TrendBadge({ direction, delta, streak }: { direction: string | null; delta: number | null; streak: number | null }) {
  return (
    <div className="flex items-center gap-1.5">
      {direction === "up" && (
        <Badge className="text-xs bg-emerald-100 text-emerald-700 border-emerald-300 gap-1">
          <TrendingUp className="h-3 w-3" />
          {delta != null ? `+${delta}` : "Rising"}
        </Badge>
      )}
      {direction === "down" && (
        <Badge className="text-xs bg-red-100 text-red-700 border-red-300 gap-1">
          <TrendingDown className="h-3 w-3" />
          {delta != null ? `${delta}` : "Falling"}
        </Badge>
      )}
      {direction === "stable" && (
        <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-300 gap-1">
          <ArrowRight className="h-3 w-3" />
          Stable
        </Badge>
      )}
      {direction === "new" && (
        <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-300 gap-1">
          <Sparkles className="h-3 w-3" />
          New
        </Badge>
      )}
      {(streak ?? 0) > 1 && (
        <Badge variant="outline" className="text-xs gap-1">
          <Flame className="h-3 w-3 text-orange-500" />
          {streak} runs
        </Badge>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { activeWorkspace } = useWorkspace();
  const { data, isLoading } = trpc.reports.getLatest.useQuery({ workspaceId: activeWorkspace?.id });
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const slug = activeWorkspace?.slug ?? "";
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxConcept, setLightboxConcept] = useState<any>(null);
  const utils = trpc.useUtils();

  const deleteConceptMut = trpc.revision.deleteConcept.useMutation({
    onSuccess: () => {
      toast.success("Concept deleted");
      utils.reports.getLatest.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const generateImageMut = trpc.concepts.generateSingleImage.useMutation({
    onSuccess: (res) => {
      if (res.success) {
        toast.success("Image generated!");
        utils.reports.getLatest.invalidate();
      } else {
        toast.error(res.message || "Image generation failed");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const triggerRun = trpc.pipeline.triggerRun.useMutation({
    onSuccess: (res) => {
      if (res.success) {
        toast.success("Pipeline started!");
        setLocation(`/${slug}/status`);
      } else {
        toast.error(res.message || "Failed to start pipeline");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to start pipeline");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const run = data?.run;
  const books = data?.books ?? [];
  const concepts = data?.concepts ?? [];
  const marketValidations = data?.marketValidations ?? [];

  const mvByConceptId = new Map(
    marketValidations.map((mv: any) => [mv.conceptId, mv])
  );

  // Global winners = concepts with isWinner flag, sorted by globalRank
  const winners = [...concepts]
    .filter((c: any) => c.isWinner)
    .sort((a: any, b: any) => (a.globalRank ?? 999) - (b.globalRank ?? 999));

  // Non-winner concepts sorted by score
  const otherConcepts = [...concepts]
    .filter((c: any) => !c.isWinner && (c.trendScore ?? 0) > 0)
    .sort((a: any, b: any) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

  // Count images
  const totalImages = concepts.filter(
    (c: any) => c.imageUrlA || c.imageUrlB || c.imageUrlC
  ).length;

  // Top book = book with most winners
  const winnerBookCounts = new Map<number, number>();
  for (const w of winners) {
    const count = winnerBookCounts.get(w.bookId) ?? 0;
    winnerBookCounts.set(w.bookId, count + 1);
  }
  const topBookId = winnerBookCounts.size > 0
    ? Array.from(winnerBookCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const topBook = topBookId ? books.find((b: any) => b.id === topBookId) : null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {run
              ? `Latest report from ${new Date(run.createdAt).toLocaleDateString()} — ${run.totalStages ?? 7} stages completed`
              : "No reports yet. Run the pipeline to get started."}
          </p>
        </div>
        {isAuthenticated && (
          <Button
            onClick={() => triggerRun.mutate({ workspaceId: activeWorkspace?.id ?? "ws-nyt-default" })}
            disabled={triggerRun.isPending}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            {triggerRun.isPending ? "Starting..." : "Run Pipeline"}
          </Button>
        )}
      </div>

      {!run ? (
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2 text-foreground">No Reports Yet</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {isNicheWorkspace
                ? 'Click "Run Pipeline" to scan niche signals, run community research, generate design concepts, score them, and create AI design images.'
                : 'Click "Run Pipeline" to fetch the latest NYT Best Sellers, run niche research, generate design concepts, score them, and create AI design images.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stats Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <BookOpen className="h-4 w-4" /> {isNicheWorkspace ? "Signals" : "Books"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-foreground">{run.booksProcessed}</p>
              </CardContent>
            </Card>
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Palette className="h-4 w-4" /> Concepts
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-foreground">{concepts.length}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {winners.length} winners
                </p>
              </CardContent>
            </Card>
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <ImageIcon className="h-4 w-4" /> Images
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-foreground">{run.imagesGenerated ?? totalImages}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  3 variations per winner
                </p>
              </CardContent>
            </Card>
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Crown className="h-4 w-4" /> {isNicheWorkspace ? "Top Signal" : "Top Book"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold truncate text-foreground">
                  {topBook?.title ?? run.topPickTitle ?? "—"}
                </p>
                {topBook && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {winnerBookCounts.get(topBookId!) ?? 0} winning concepts
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* WINNER SPOTLIGHT — The most important section */}
          {winners.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="h-5 w-5 text-amber-500" />
                <h2 className="text-xl font-bold text-foreground">
                  Winning Concepts
                </h2>
                <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-xs">
                  Top {winners.length} globally
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Ranked by composite score across all {books.length} {isNicheWorkspace ? "signals" : "books"}. Each winner gets 3 image variations: Clean/Commercial, Bold/Artistic, and Trending/Social.
              </p>

              {/* Winner thumbnail grid */}
              <div className="flex flex-wrap gap-3 mb-6">
                {winners.filter((c: any) => c.imageUrlA || c.imageUrlB || c.imageUrlC).map((c: any) => (
                  <ImageThumbnail
                    key={c.id}
                    src={c.imageUrlA || c.imageUrlB || c.imageUrlC}
                    alt={c.conceptName}
                    size={80}
                    badge={`#${c.globalRank}`}
                    onClick={() => { setLightboxConcept(c); setLightboxOpen(true); }}
                  />
                ))}
              </div>
              <div className="space-y-4">
                {winners.map((concept: any) => {
                  const mv = mvByConceptId.get(concept.id);
                  const book = books.find((b: any) => b.id === concept.bookId);
                  return (
                    <ConceptCard
                      key={concept.id}
                      id={concept.id}
                      conceptName={concept.conceptName}
                      format={concept.format}
                      style={concept.style}
                      headline={concept.headline}
                      subtext={concept.subtext}
                      colorPalette={concept.colorPalette}
                      layoutDescription={concept.layoutDescription}
                      fontSuggestion={concept.fontSuggestion}
                      copyrightSafe={concept.copyrightSafe}
                      isFavorite={concept.isFavorite}
                      humorFramework={concept.humorFramework}
                      trendScore={concept.trendScore}
                      trendRationale={concept.trendRationale}
                      imageUrlA={concept.imageUrlA}
                      imageUrlB={concept.imageUrlB}
                      imageUrlC={concept.imageUrlC}
                      imagePromptA={concept.imagePromptA}
                      imagePromptB={concept.imagePromptB}
                      imagePromptC={concept.imagePromptC}
                      isWinner={concept.isWinner}
                      globalRank={concept.globalRank}
                      marketValidation={mv ?? null}
                      showImages={true}
                      bookId={concept.bookId}
                      bookTitle={book?.title}
                      bookAuthor={book?.author}
                      onDelete={(id) => deleteConceptMut.mutate({ conceptId: id })}
                      onGenerateImage={(id) => generateImageMut.mutate({ conceptId: id })}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Books Overview */}
          {books.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 text-foreground">Books Analyzed</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...books]
                  .sort((a: any, b: any) => (b.trendScoreTotal ?? 0) - (a.trendScoreTotal ?? 0))
                  .map((book: any) => {
                    const bookWinnerCount = winnerBookCounts.get(book.id) ?? 0;
                    return (
                      <Card
                        key={book.id}
                        className={`cursor-pointer transition-all hover:shadow-md ${
                          bookWinnerCount > 0
                            ? "border-amber-200 bg-amber-50/20"
                            : "border-border hover:border-primary/30"
                        }`}
                       onClick={() => setLocation(`/${slug}/book/${book.id}`)}
                      >
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between">
                            <div className="min-w-0">
                              <CardTitle className="text-sm font-semibold text-foreground">
                                {book.title}
                              </CardTitle>
                              <p className="text-xs text-muted-foreground">
                                {book.author}
                              </p>
                            </div>
                            {bookWinnerCount > 0 && (
                              <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px] shrink-0">
                                <Trophy className="h-2.5 w-2.5 mr-0.5" />
                                {bookWinnerCount} winner{bookWinnerCount > 1 ? "s" : ""}
                              </Badge>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          <TrendBadge
                            direction={book.trendDirection}
                            delta={book.scoreDelta}
                            streak={book.streakCount}
                          />
                          <div className="flex flex-wrap gap-1">
                            {book.subgenre && (
                              <Badge variant="secondary" className="text-xs">
                                {book.subgenre}
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-xs">
                              Rank #{book.rank}
                            </Badge>
                          </div>
                          {book.forumSignals && (
                            <ForumSignalsBadge forumSignals={book.forumSignals as any} compact />
                          )}
                          {book.dominantColors && (
                            <ColorSwatch colors={book.dominantColors} size="sm" />
                          )}
                          {book.trendScoreTotal != null && (
                            <TrendBar
                              label="Score"
                              score={book.trendScoreTotal}
                              maxScore={300}
                            />
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Other Concepts (non-winners) — collapsed by default */}
          {otherConcepts.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 text-foreground">
                Other Concepts ({otherConcepts.length})
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {otherConcepts.slice(0, 9).map((concept: any) => {
                  const mv = mvByConceptId.get(concept.id);
                  const book = books.find((b: any) => b.id === concept.bookId);
                  return (
                    <ConceptCard
                      key={concept.id}
                      id={concept.id}
                      conceptName={concept.conceptName}
                      format={concept.format}
                      style={concept.style}
                      headline={concept.headline}
                      subtext={concept.subtext}
                      colorPalette={concept.colorPalette}
                      layoutDescription={concept.layoutDescription}
                      fontSuggestion={concept.fontSuggestion}
                      copyrightSafe={concept.copyrightSafe}
                      isFavorite={concept.isFavorite}
                      humorFramework={concept.humorFramework}
                      trendScore={concept.trendScore}
                      imageUrlA={concept.imageUrlA}
                      imageUrlB={concept.imageUrlB}
                      imageUrlC={concept.imageUrlC}
                      imagePromptA={concept.imagePromptA}
                      imagePromptB={concept.imagePromptB}
                      imagePromptC={concept.imagePromptC}
                      isWinner={false}
                      globalRank={concept.globalRank}
                      marketValidation={mv ?? null}
                      showImages={false}
                      compact={true}
                      bookId={concept.bookId}
                      bookTitle={book?.title}
                      bookAuthor={book?.author}
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

      {/* Lightbox */}
      {lightboxConcept && (
        <ImageLightbox
          isOpen={lightboxOpen}
          onClose={() => { setLightboxOpen(false); setLightboxConcept(null); }}
          conceptId={lightboxConcept.id}
          conceptName={lightboxConcept.conceptName}
          images={{
            A: lightboxConcept.imageUrlA,
            B: lightboxConcept.imageUrlB,
            C: lightboxConcept.imageUrlC,
          }}
          detail={(() => {
            const book = books.find((b: any) => b.id === lightboxConcept.bookId);
            return {
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
            };
          })()}
        />
      )}
    </div>
  );
}
