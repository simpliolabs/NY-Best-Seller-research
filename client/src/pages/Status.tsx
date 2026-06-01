import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import BrowserScraper from "@/components/BrowserScraper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useState, useEffect } from "react";
import {
  Activity,
  Play,
  CheckCircle,
  XCircle,
  Loader2,
  Download,
  Search,
  Palette,
  TrendingUp,
  FileText,
  Users,
  Image as ImageIcon,
  OctagonX,
  Clock,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";

// Stage 1 label/description is dynamic based on workspace type — resolved at render time
const STAGES_NYT = [
  { num: 1, label: "Ingest NYT Data", icon: Download, description: "Fetching bestseller list from NYT API" },
];
const STAGES_NICHE = [
  { num: 1, label: "Scan Niche Signals", icon: Download, description: "Scanning Reddit communities + Etsy bestsellers for niche trends" },
];
const STAGES = [
  { num: 1, label: "Ingest NYT Data", icon: Download, description: "Fetching bestseller list from NYT API" },
  { num: 2, label: "Extract + Forum Scraping", icon: Search, description: "Extracts metadata + scrapes Goodreads, StoryGraph, Reddit, Fable, Book Riot for real fan signals" },
  { num: 3, label: "Niche Research", icon: Users, description: "Deep research: fan conversations, design styles, white space" },
  { num: 4, label: "Generate 5 Concepts", icon: Palette, description: "5 concepts per book using humor frameworks" },
  { num: 5, label: "Score + Validate", icon: TrendingUp, description: "Cross-reference scoring (Etsy market data when key is active)" },
  { num: 6, label: "Design Image Generation", icon: ImageIcon, description: "AI generates 3 image variations per winning concept (top 5 globally, 15 max)" },
  { num: 7, label: "Report & Notify", icon: FileText, description: "Final report assembly and owner notification" },
];

const FORCE_KILL_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

function useElapsedTime(startTime: number | null, isRunning: boolean) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime || !isRunning) {
      setElapsed(0);
      return;
    }
    const update = () => setElapsed(Date.now() - startTime);
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime, isRunning]);

  return elapsed;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

export default function Status() {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const stages = [
    ...(isNicheWorkspace ? STAGES_NICHE : STAGES_NYT),
    ...STAGES.slice(1),
  ];

  const { data, isLoading } = trpc.pipeline.getStatus.useQuery(undefined, {
    refetchInterval: (query) => {
      return query.state.data?.isRunning ? 3000 : false;
    },
  });

  const utils = trpc.useUtils();

  const triggerRun = trpc.pipeline.triggerRun.useMutation({
    onSuccess: (res) => {
      if (res.success) {
        toast.success("Pipeline started!");
        utils.pipeline.getStatus.invalidate();
      } else {
        toast.error(res.message || "Failed to start pipeline");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to start pipeline");
    },
  });

  const cancelRun = trpc.pipeline.cancelRun.useMutation({
    onSuccess: (res) => {
      if (res.success) {
        toast.success("Pipeline run cancelled.");
        utils.pipeline.getStatus.invalidate();
      } else {
        toast.error(res.message || "Failed to cancel run");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to cancel run");
    },
  });

  const run = data?.run;
  const isRunning = data?.isRunning ?? false;
  const currentStage = run?.currentStage ?? 0;
  const totalStages = run?.totalStages ?? 7;
  const progressPct = run ? Math.min(100, (currentStage / totalStages) * 100) : 0;

  const startTime = run?.createdAt ? new Date(run.createdAt).getTime() : null;
  const elapsed = useElapsedTime(startTime, isRunning);
  const showForceKill = isRunning && elapsed > FORCE_KILL_THRESHOLD_MS;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" /> Run Status
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor the 7-stage pipeline: ingest, extract, niche research, concepts, scoring, image generation, and report.
          </p>
        </div>
        {isAuthenticated && !isRunning && (
          <Button
            onClick={() => triggerRun.mutate({ workspaceId: activeWorkspace?.id ?? "ws-nyt-default" })}
            disabled={triggerRun.isPending}
            className="gap-2"
          >
            {triggerRun.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Starting...</>
            ) : (
              <><Play className="h-4 w-4" /> Run Pipeline</>
            )}
          </Button>
        )}
      </div>

      {/* Pipeline Progress */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {run ? `Run #${run.id}` : "No Runs"}
            </CardTitle>
            {run && (
              <div className="flex items-center gap-2">
                {run.imagesGenerated != null && run.imagesGenerated > 0 && (
                  <Badge variant="outline" className="bg-violet-100 text-violet-700 border-violet-300 text-xs">
                    <ImageIcon className="h-3 w-3 mr-1" />
                    {run.imagesGenerated} images
                  </Badge>
                )}
                <Badge
                  variant={
                    run.status === "completed"
                      ? "default"
                      : run.status === "failed"
                      ? "destructive"
                      : "secondary"
                  }
                  className={
                    run.status === "completed"
                      ? "bg-emerald-100 text-emerald-700 border-emerald-300"
                      : run.status === "failed"
                      ? "bg-red-100 text-red-700 border-red-300"
                      : "bg-amber-100 text-amber-700 border-amber-300"
                  }
                >
                  {run.status === "completed" && <CheckCircle className="h-3 w-3 mr-1" />}
                  {run.status === "failed" && <XCircle className="h-3 w-3 mr-1" />}
                  {run.status === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  {run.status}
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {run && (
            <>
              {/* Overall progress bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Overall Progress</span>
                  <span className="font-mono">{currentStage}/{totalStages} stages — {Math.round(progressPct)}%</span>
                </div>
                <Progress value={progressPct} className="h-2" />
                {run.stageLabel && (
                  <p className="text-xs text-muted-foreground">{run.stageLabel}</p>
                )}
              </div>

              {/* ═══ STOP / FORCE KILL — directly below progress bar ═══ */}
              {isRunning && isAuthenticated && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      <span>Elapsed: <span className="font-mono font-medium text-foreground">{formatElapsed(elapsed)}</span></span>
                    </div>
                    {showForceKill && (
                      <div className="flex items-center gap-1.5 text-amber-600 text-xs">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>Running longer than expected</span>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="destructive"
                    size="lg"
                    className={`w-full gap-2 text-base font-semibold py-6 ${
                      showForceKill
                        ? "bg-red-600 hover:bg-red-700 animate-pulse"
                        : "bg-red-500 hover:bg-red-600"
                    }`}
                    onClick={() => cancelRun.mutate({ runId: run.id })}
                    disabled={cancelRun.isPending}
                  >
                    {cancelRun.isPending ? (
                      <><Loader2 className="h-5 w-5 animate-spin" /> Stopping Pipeline...</>
                    ) : showForceKill ? (
                      <><Zap className="h-5 w-5" /> FORCE KILL — Pipeline Stuck ({formatElapsed(elapsed)})</>
                    ) : (
                      <><OctagonX className="h-5 w-5" /> STOP Pipeline</>
                    )}
                  </Button>
                </div>
              )}

              {/* Browser signal enrichment — auto-triggers at Stage 5+ */}
              {isRunning && currentStage >= 5 && run?.id && (
                <BrowserScraper runId={run.id} />
              )}

              {/* Stage indicators */}
              <div className="space-y-3">
                {stages.map((stage) => {
                  const StageIcon = stage.icon;
                  const isComplete = currentStage > stage.num || run.status === "completed";
                  const isCurrent = currentStage === stage.num && isRunning;
                  const isFailed = run.status === "failed" && currentStage === stage.num;

                  return (
                    <div
                      key={stage.num}
                      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                        isCurrent
                          ? "border-primary/50 bg-primary/5"
                          : isComplete
                          ? "border-green-500/20 bg-green-500/5"
                          : isFailed
                          ? "border-red-500/20 bg-red-500/5"
                          : "border-border/50"
                      }`}
                    >
                      <div
                        className={`flex items-center justify-center h-8 w-8 rounded-full shrink-0 ${
                          isComplete
                            ? "bg-emerald-100 text-emerald-700"
                            : isCurrent
                            ? "bg-primary/20 text-primary"
                            : isFailed
                            ? "bg-red-100 text-red-700"
                            : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {isComplete ? (
                          <CheckCircle className="h-4 w-4" />
                        ) : isCurrent ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : isFailed ? (
                          <XCircle className="h-4 w-4" />
                        ) : (
                          <StageIcon className="h-4 w-4" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          Stage {stage.num}: {stage.label}
                        </p>
                        <p className="text-xs text-muted-foreground">{stage.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Run info */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm pt-2 border-t border-border">
                <div>
                  <p className="text-muted-foreground">Started</p>
                  <p className="font-medium">{new Date(run.createdAt).toLocaleString()}</p>
                </div>
                {run.completedAt && (
                  <div>
                    <p className="text-muted-foreground">Completed</p>
                    <p className="font-medium">{new Date(run.completedAt).toLocaleString()}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground">{isNicheWorkspace ? "Signals Processed" : "Books Processed"}</p>
                  <p className="font-medium">{run.booksProcessed ?? 0}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Images Generated</p>
                  <p className="font-medium">{run.imagesGenerated ?? 0}</p>
                </div>
              </div>

              {/* View report link */}
              {run.status === "completed" && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setLocation(`/${slug}/report/${run.id}`)}
                >
                  View Full Report
                </Button>
              )}
            </>
          )}

          {!run && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Activity className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-sm text-muted-foreground">
                No pipeline runs yet. Click "Run Pipeline" to start the 7-stage analysis.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error Log */}
      {run?.errorLog && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base text-destructive flex items-center gap-2">
              <XCircle className="h-4 w-4" /> Error Log
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs font-mono text-destructive/80 whitespace-pre-wrap bg-destructive/5 p-4 rounded-md overflow-auto max-h-64">
              {run.errorLog}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Schedule Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pipeline Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-muted-foreground text-xs">{isNicheWorkspace ? "Signals per run" : "Books per run"}</p>
              <p className="font-semibold">{isNicheWorkspace ? "10 niche signals" : "6 top books"}</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-muted-foreground text-xs">{isNicheWorkspace ? "Concepts per signal" : "Concepts per book"}</p>
              <p className="font-semibold">5 concepts</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-muted-foreground text-xs">Winner images</p>
              <p className="font-semibold">Top 5 × 3 = 15 max</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-muted-foreground text-xs">Timeout</p>
              <p className="font-semibold">7 min overall</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {isNicheWorkspace
              ? "Stages 2-4 run in parallel across all signals. Image generation runs in parallel for all winners. If image generation fails, the pipeline still completes with all other data."
              : "Stages 2-4 run in parallel across all books. Image generation runs in parallel for all winners. If image generation fails, the pipeline still completes with all other data."
            }
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
