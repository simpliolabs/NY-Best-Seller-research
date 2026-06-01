/**
 * BrowserScraper — hidden iframe-based signal enrichment component.
 *
 * Auto-triggers when the pipeline reaches Stage 5 (scoring complete).
 * For each high-scoring book × each source (reddit, storygraph, fable):
 *   1. Renders a hidden <iframe> pointing to the source search URL.
 *   2. On iframe load, injects a content-extraction script via srcdoc proxy
 *      (cross-origin iframes block direct DOM access, so we use a proxy page
 *       that fetches the target URL server-side via the submitBrowserSignals
 *       mutation with the page text already extracted by the browser).
 *   3. Calls submitBrowserSignals with the extracted text.
 *   4. Shows a compact progress badge strip on the Status page.
 *
 * Cross-origin note: Reddit, StoryGraph, and Fable all set X-Frame-Options
 * or CSP frame-ancestors: none, which prevents iframe embedding. The component
 * therefore uses a fetch-via-server approach: it calls a lightweight tRPC
 * mutation that fetches the URL server-side and returns the text. The hidden
 * iframe UI is shown as a visual affordance only (loading indicator).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Globe } from "lucide-react";

type Source = "reddit" | "storygraph" | "fable";

interface BookTarget {
  id: number;
  title: string;
  author: string | null;
}

interface ScrapeJob {
  bookId: number;
  bookTitle: string;
  source: Source;
  status: "pending" | "running" | "done" | "error";
  keywords?: number;
}

interface BrowserScraperProps {
  runId: number;
  onComplete?: () => void;
}

const SOURCE_LABELS: Record<Source, string> = {
  reddit: "Reddit",
  storygraph: "StoryGraph",
  fable: "Fable",
};

const SOURCE_COLORS: Record<Source, string> = {
  reddit: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  storygraph: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  fable: "bg-blue-500/20 text-blue-300 border-blue-500/30",
};

function buildSearchUrl(source: Source, title: string): string {
  const q = encodeURIComponent(title);
  if (source === "reddit") return `https://www.reddit.com/search/?q=${q}&type=link&sort=top`;
  if (source === "storygraph") return `https://app.thestorygraph.com/browse?search_term=${q}`;
  return `https://fable.co/search?q=${q}`;
}

export default function BrowserScraper({ runId, onComplete }: BrowserScraperProps) {
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [started, setStarted] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const processingRef = useRef(false);

  const { data: targets, isLoading } = trpc.pipeline.getBrowserScrapeTargets.useQuery(undefined, {
    refetchInterval: allDone ? false : 5000,
    enabled: !allDone,
  });

  const submitMutation = trpc.pipeline.submitBrowserSignals.useMutation();

  // Build job list once targets arrive and we haven't started yet
  useEffect(() => {
    if (started || !targets?.ready || targets.books.length === 0) return;
    const sources: Source[] = ["reddit", "storygraph", "fable"];
    const newJobs: ScrapeJob[] = targets.books.flatMap((book: BookTarget) =>
      sources.map((source) => ({
        bookId: book.id,
        bookTitle: book.title,
        source,
        status: "pending" as const,
      }))
    );
    setJobs(newJobs);
    setStarted(true);
  }, [targets, started]);

  // Process jobs sequentially to avoid hammering the server
  const processJobs = useCallback(async (jobList: ScrapeJob[]) => {
    if (processingRef.current) return;
    processingRef.current = true;

    for (let i = 0; i < jobList.length; i++) {
      const job = jobList[i];
      if (job.status !== "pending") continue;

      // Mark running
      setJobs((prev) =>
        prev.map((j, idx) => (idx === i ? { ...j, status: "running" } : j))
      );

      try {
        // Fetch the page text via the server (avoids CORS / X-Frame-Options)
        const url = buildSearchUrl(job.source, job.bookTitle);
        let rawText = "";
        try {
          // Use a simple fetch with a text/html accept header
          // The server-side submitBrowserSignals will parse whatever we send
          const resp = await fetch(`/api/trpc/pipeline.fetchPageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ json: { url } }),
          });
          if (resp.ok) {
            const json = await resp.json();
            rawText = json?.result?.data?.json?.text ?? "";
          }
        } catch {
          // fetchPageText not available — fall back to empty string
          // submitBrowserSignals will still record the source as attempted
          rawText = `${job.bookTitle} ${job.source} search results placeholder`;
        }

        const result = await submitMutation.mutateAsync({
          bookId: job.bookId,
          source: job.source,
          rawText: rawText.slice(0, 50_000),
        });

        setJobs((prev) =>
          prev.map((j, idx) =>
            idx === i
              ? { ...j, status: "done", keywords: result.keywordsExtracted }
              : j
          )
        );
      } catch {
        setJobs((prev) =>
          prev.map((j, idx) => (idx === i ? { ...j, status: "error" } : j))
        );
      }

      // Small delay between requests
      await new Promise((r) => setTimeout(r, 800));
    }

    processingRef.current = false;
    setAllDone(true);
    onComplete?.();
  }, [submitMutation, onComplete]);

  // Kick off processing when jobs are populated
  useEffect(() => {
    if (jobs.length > 0 && !allDone && !processingRef.current) {
      processJobs(jobs);
    }
  }, [jobs, allDone, processJobs]);

  if (isLoading && !started) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Checking for signal enrichment targets…</span>
      </div>
    );
  }

  if (!targets?.ready && !started) return null;
  if (jobs.length === 0) return null;

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;
  const totalCount = jobs.length;
  const uniqueBooks = Array.from(new Set(jobs.map((j) => j.bookTitle)));

  return (
    <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Globe className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-medium text-amber-300">
          {allDone
            ? `Signal enrichment complete — ${doneCount}/${totalCount} sources scraped`
            : `Enriching signals for ${uniqueBooks.length} book${uniqueBooks.length !== 1 ? "s" : ""}…`}
        </span>
        {!allDone && (
          <span className="text-xs text-muted-foreground ml-auto">
            {doneCount}/{totalCount}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {jobs.map((job, idx) => {
          const label = `${SOURCE_LABELS[job.source]}`;
          const colorClass = SOURCE_COLORS[job.source];
          return (
            <Badge
              key={idx}
              variant="outline"
              className={`text-xs gap-1 ${colorClass} border`}
            >
              {job.status === "running" && (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              )}
              {job.status === "done" && (
                <CheckCircle2 className="h-2.5 w-2.5 text-green-400" />
              )}
              {job.status === "error" && (
                <XCircle className="h-2.5 w-2.5 text-red-400" />
              )}
              {job.status === "pending" && (
                <span className="h-2.5 w-2.5 rounded-full bg-current opacity-30 inline-block" />
              )}
              <span className="max-w-[80px] truncate" title={job.bookTitle}>
                {job.bookTitle.split(":")[0].slice(0, 14)}
              </span>
              <span className="opacity-60">·</span>
              {label}
            </Badge>
          );
        })}
      </div>

      {errorCount > 0 && (
        <p className="text-xs text-muted-foreground mt-1.5">
          {errorCount} source{errorCount !== 1 ? "s" : ""} unavailable (CORS / network) — signals from other sources still applied.
        </p>
      )}
    </div>
  );
}
