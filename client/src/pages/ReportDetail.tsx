import { trpc } from "@/lib/trpc";
import { useRoute, useLocation, Link } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ColorSwatch } from "@/components/ColorSwatch";
import { TrendBar } from "@/components/TrendBar";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle,
  XCircle,
  Image as ImageIcon,
  Lightbulb,
  Users,
  Trophy,
} from "lucide-react";
import { ImageThumbnail } from "@/components/ImageThumbnail";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function ReportDetail() {
  const [match, params] = useRoute("/:slug/report/:id");
  const [, setLocation] = useLocation();
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const runId = match ? parseInt(params.id, 10) : 0;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxConcept, setLightboxConcept] = useState<any>(null);
  const [regenLoading, setRegenLoading] = useState(false);
  const utils = trpc.useUtils();

  const [prodProcessLoading, setProdProcessLoading] = useState(false);

  const processProductionImages = trpc.pipeline.processProductionImages.useMutation({
    onSuccess: (result) => {
      setProdProcessLoading(false);
      if (result.success) {
        toast.success(`Production images processed! ${result.message}`);
        utils.reports.getByRunId.invalidate({ runId, workspaceId });
      } else {
        toast.error(result.message);
      }
    },
    onError: (err) => {
      setProdProcessLoading(false);
      toast.error(err.message);
    },
  });

  const regenerateImages = trpc.pipeline.regenerateImages.useMutation({
    onSuccess: (result) => {
      setRegenLoading(false);
      if (result.success) {
        toast.success(`Images generated! ${result.message}`);
        utils.reports.getByRunId.invalidate({ runId, workspaceId });
      } else {
        toast.error(result.message);
      }
    },
    onError: (err) => {
      setRegenLoading(false);
      toast.error(err.message);
    },
  });

  const workspaceId = activeWorkspace?.id ?? "";
  const { data, isLoading } = trpc.reports.getByRunId.useQuery(
    { runId, workspaceId },
    { enabled: runId > 0 && !!workspaceId }
  );

  if (isLoading || !match) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const run = data?.run;
  const books = data?.books ?? [];
  const concepts = data?.concepts ?? [];
  const nicheResearch = data?.nicheResearch ?? [];
  const marketValidations = data?.marketValidations ?? [];

  if (!run) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setLocation(`/${slug}/history`)} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back to History
        </Button>
        <p className="text-muted-foreground">Report not found in this workspace.</p>
      </div>
    );
  }

  const isCompleted = run.status === "completed";
  const isFailed = run.status === "failed";
  const imagesCount = concepts.filter((c: any) => c.imageUrlA || c.imageUrlB).length;
  const highScorers = concepts.filter((c: any) => (c.trendScore ?? 0) >= 70).length;
  const winnerCount = concepts.filter((c: any) => c.isWinner).length;
  // Show Regenerate Images for completed OR failed runs that have winners but no images
  const canRegenerateImages = (isCompleted || isFailed) && winnerCount > 0 && (run.imagesGenerated ?? imagesCount) === 0;
  // Show "Process Production Images" when run has images but some concepts lack productionUrl
  const hasImages = imagesCount > 0;
  const hasUnprocessedImages = hasImages && concepts.some((c: any) => (c.imageUrlA || c.imageUrlB || c.imageUrlC) && !c.productionUrlA && !c.productionUrlB && !c.productionUrlC);
  // Detect scoring failure: run completed but ALL concepts have null trendScore
  const scoringFailed = isCompleted && concepts.length > 0 && concepts.every((c: any) => c.trendScore === null || c.trendScore === undefined);
  // Show regen button also when scoring failed (no winners because scoring never ran)
  const canRegenerateFromScoringFailure = scoringFailed && (run.imagesGenerated ?? imagesCount) === 0;

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={() => setLocation(`/${slug}/history`)} className="gap-2">
        <ArrowLeft className="h-4 w-4" /> Back to History
      </Button>

      {/* Run Summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">Run #{run.id}</CardTitle>
            <Badge
              variant={isCompleted ? "default" : "destructive"}
              className={
                isCompleted
                  ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                  : "bg-red-100 text-red-700 border-red-200"
              }
            >
              {isCompleted ? (
                <CheckCircle className="h-3 w-3 mr-1" />
              ) : (
                <XCircle className="h-3 w-3 mr-1" />
              )}
              {run.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Date</p>
              <p className="font-medium">{new Date(run.createdAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{isNicheWorkspace ? "Signals" : "Books"}</p>
              <p className="font-medium">{run.booksProcessed}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Concepts</p>
              <p className="font-medium">{concepts.length}</p>
            </div>
            <div>
              <p className="text-muted-foreground flex items-center gap-1">
                <Users className="h-3 w-3" /> Niche Research
              </p>
              <p className="font-medium">{nicheResearch.length} {isNicheWorkspace ? "signals" : "books"}</p>
            </div>
            <div>
              <p className="text-muted-foreground flex items-center gap-1">
                <ImageIcon className="h-3 w-3" /> Images
              </p>
              <p className="font-medium">{run.imagesGenerated ?? imagesCount}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Top Pick</p>
              <p className="font-medium truncate">{run.topPickTitle || "—"}</p>
            </div>
          </div>

          {/* Pipeline stage summary */}
          <div className="flex flex-wrap gap-2 mt-3">
            <Badge variant="outline" className="text-xs">
              {run.currentStage ?? 7}/{run.totalStages ?? 7} stages
            </Badge>
            {highScorers > 0 && (
              <Badge variant="outline" className="text-xs bg-emerald-100 text-emerald-700 border-emerald-200">
                <Lightbulb className="h-2.5 w-2.5 mr-1" />
                {highScorers} high-scoring concepts
              </Badge>
            )}
            {marketValidations.length > 0 && (
              <Badge variant="outline" className="text-xs bg-blue-100 text-blue-700 border-blue-200">
                {marketValidations.length} Etsy validations
              </Badge>
            )}
          </div>

          {run.errorLog && (
            <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/20">
              <details>
                <summary className="text-xs font-medium text-destructive cursor-pointer select-none">
                  Run failed — click to see error details
                </summary>
                <p className="mt-2 text-xs font-mono text-destructive break-all whitespace-pre-wrap">
                  {run.errorLog.replace(/update\s+`?\w+`?\s+set[\s\S]*/i, "[Database error — see server logs]")}
                </p>
              </details>
            </div>
          )}

          {/* Scoring failed warning — run completed but all concepts have NULL trendScore */}
          {canRegenerateFromScoringFailure && (
            <div className="mt-4 flex items-center gap-3 p-3 rounded-md bg-red-50 border border-red-200">
              <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800">Scoring timed out — no images were generated</p>
                <p className="text-xs text-red-600">The AI scoring step exceeded its time limit. Click to re-score concepts and generate images (takes 3–5 minutes).</p>
              </div>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white shrink-0"
                disabled={regenLoading}
                onClick={() => {
                  setRegenLoading(true);
                  regenerateImages.mutate({ runId });
                }}
              >
                {regenLoading ? (
                  <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Generating...</>
                ) : (
                  <><RefreshCw className="h-3 w-3 mr-1" /> Re-score &amp; Generate</>
                )}
              </Button>
            </div>
          )}

          {/* Process Production Images — shown when run has images but no production (transparent) URLs yet */}
          {hasUnprocessedImages && (isCompleted || isFailed) && (
            <div className="mt-4 flex items-center gap-3 p-3 rounded-md bg-blue-50 border border-blue-200">
              <ImageIcon className="h-4 w-4 text-blue-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-800">Mockup images need background removal</p>
                <p className="text-xs text-blue-600">Click to process design images for clean transparent compositing (takes 1–2 min per image)</p>
              </div>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white shrink-0"
                disabled={prodProcessLoading}
                onClick={() => {
                  setProdProcessLoading(true);
                  processProductionImages.mutate({ runId });
                }}
              >
                {prodProcessLoading ? (
                  <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Processing...</>
                ) : (
                  <><ImageIcon className="h-3 w-3 mr-1" /> Process Images</>
                )}
              </Button>
            </div>
          )}

          {/* Regenerate Images button — shown when run has winners but 0 images (completed or failed) */}
          {canRegenerateImages && (
            <div className="mt-4 flex items-center gap-3 p-3 rounded-md bg-amber-50 border border-amber-200">
              <RefreshCw className="h-4 w-4 text-amber-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">No images were generated for this run</p>
                <p className="text-xs text-amber-600">Click to generate images for the top 5 winner concepts (takes 2–3 minutes)</p>
              </div>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 text-white shrink-0"
                disabled={regenLoading}
                onClick={() => {
                  setRegenLoading(true);
                  regenerateImages.mutate({ runId });
                }}
              >
                {regenLoading ? (
                  <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Generating...</>
                ) : (
                  <><RefreshCw className="h-3 w-3 mr-1" /> Regenerate Images</>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Winners Section */}
      {(() => {
        const winners = concepts.filter((c: any) => c.isWinner).sort((a: any, b: any) => (a.globalRank ?? 999) - (b.globalRank ?? 999));
        if (winners.length === 0) return null;
        return (
          <div>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-500" /> Winners ({winners.length})
            </h2>
            <div className="flex flex-wrap gap-4">
              {winners.map((c: any) => {
                const hasImage = c.productionUrlA || c.imageUrlA || c.productionUrlB || c.imageUrlB || c.productionUrlC || c.imageUrlC;
                const book = books.find((b: any) => b.id === c.bookId);
                return (
                  <Card key={c.id} className="w-[180px] overflow-hidden border-amber-200 bg-amber-50/20 cursor-pointer hover:shadow-md transition-shadow"
                    onClick={() => { if (hasImage) { setLightboxConcept(c); setLightboxOpen(true); } }}
                  >
                    <div className="aspect-square relative bg-muted">
                      {hasImage ? (
                        <ImageThumbnail
                          src={c.productionUrlA || c.imageUrlA || c.productionUrlB || c.imageUrlB || c.productionUrlC || c.imageUrlC}
                          alt={c.conceptName}
                          size={180}
                          badge={`#${c.globalRank}`}
                          className="!w-full !h-full !rounded-none"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">No image</div>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="text-xs font-semibold truncate">{c.conceptName}</p>
                      {book ? (
                        <Link href={`/${slug}/book/${book.id}`} className="text-[10px] text-primary hover:underline truncate block" onClick={(e) => e.stopPropagation()}>{book.title}</Link>
                      ) : (
                        <p className="text-[10px] text-muted-foreground truncate">Unknown</p>
                      )}
                      {c.trendScore && (
                        <div className="mt-1 flex items-center gap-1">
                          <div className="h-1 w-12 bg-muted rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, (c.trendScore / 300) * 100)}%` }} />
                          </div>
                          <span className="text-[10px] font-mono">{c.trendScore}</span>
                        </div>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Books from this run */}
      {books.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" /> {isNicheWorkspace ? "Signals" : "Books"} ({books.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {books.map((book: any) => {
              const hasNiche = nicheResearch.some((nr: any) => nr.bookId === book.id);
              return (
                <Card
                  key={book.id}
                  className="hover:border-primary/30 transition-colors cursor-pointer"
                  onClick={() => setLocation(`/${slug}/book/${book.id}`)}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold">{book.title}</CardTitle>
                    <p className="text-xs text-muted-foreground">{book.author}</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {book.subgenre && (
                        <Badge variant="secondary" className="text-xs">{book.subgenre}</Badge>
                      )}
                      {book.mood && (
                        <Badge variant="outline" className="text-xs">{book.mood}</Badge>
                      )}
                      {hasNiche && (
                        <Badge variant="outline" className="text-xs bg-violet-100 text-violet-700 border-violet-200">
                          <Users className="h-2.5 w-2.5 mr-1" />
                          Researched
                        </Badge>
                      )}
                    </div>
                    {book.dominantColors && (
                      <ColorSwatch colors={book.dominantColors} size="sm" />
                    )}
                    {book.trendScoreTotal != null && (
                      <TrendBar label="Score" score={book.trendScoreTotal} maxScore={300} />
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
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
              sourcePhrase: lightboxConcept.sourcePhrase ?? null,
              bookSocialMomentum: book?.socialMomentum ?? null,
              bookSocialRationale: book?.socialRationale ?? null,
              bookDesignNovelty: book?.designNovelty ?? null,
              bookDesignRationale: book?.designRationale ?? null,
              bookAudienceSize: book?.audienceSize ?? null,
              bookAudienceRationale: book?.audienceRationale ?? null,
            };
          })()}
        />
      )}
    </div>
  );
}
