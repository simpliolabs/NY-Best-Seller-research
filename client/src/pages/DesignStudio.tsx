/**
 * DesignStudio — Phase G + Phase 4 (single-concept routing)
 * Review and revise winning design concepts with GPT Image.
 * Supports ?conceptId=X URL param to show only that concept.
 * Without param: shows all concepts from latest run (original behavior).
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { RevisionPanel } from "@/components/RevisionPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Paintbrush, Trophy, ImageIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useSearch } from "wouter";

export default function DesignStudio() {
  const { activeWorkspace } = useWorkspace();
  const [selectedConceptId, setSelectedConceptId] = useState<number | null>(null);
  const utils = trpc.useUtils();

  const deleteConceptMut = trpc.revision.deleteConcept.useMutation({
    onSuccess: () => {
      toast.success("Concept deleted");
      utils.revision.getReviewQueue.invalidate();
      setSelectedConceptId(null);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Parse ?conceptId= from URL
  const searchString = useSearch();
  const urlConceptId = useMemo(() => {
    const params = new URLSearchParams(searchString);
    const raw = params.get("conceptId");
    return raw ? parseInt(raw, 10) : null;
  }, [searchString]);

  // Get the latest completed run for this workspace
  const latestRunQuery = trpc.reports.getLatest.useQuery(
    { workspaceId: activeWorkspace?.id },
    { enabled: !!activeWorkspace }
  );

  // Get the review queue (concepts with images) from the latest run
  const runId = latestRunQuery.data?.run?.id;
  const reviewQueueQuery = trpc.revision.getReviewQueue.useQuery(
    { runId: runId! },
    { enabled: !!runId }
  );

  // Single concept fetch when conceptId is in URL but not in the run queue
  const singleConceptQuery = trpc.revision.getConcept.useQuery(
    { conceptId: urlConceptId! },
    { enabled: !!urlConceptId }
  );

  // Build the concepts list: if URL param is set, show only that concept
  const allConcepts = reviewQueueQuery.data ?? [];
  const concepts = useMemo(() => {
    if (!urlConceptId) return allConcepts;
    // Try to find in the run queue first
    const fromQueue = allConcepts.find((c) => c.id === urlConceptId);
    if (fromQueue) return [fromQueue];
    // Fall back to single-concept fetch
    if (singleConceptQuery.data) return [singleConceptQuery.data];
    return [];
  }, [urlConceptId, allConcepts, singleConceptQuery.data]);

  // Auto-select first concept if none selected
  const effectiveConcept = useMemo(() => {
    if (selectedConceptId) {
      return concepts.find((c) => c.id === selectedConceptId) ?? concepts[0] ?? null;
    }
    return concepts[0] ?? null;
  }, [selectedConceptId, concepts]);

  // Determine which variations have images for the selected concept
  const variations = useMemo(() => {
    if (!effectiveConcept) return [];
    const v: { key: "A" | "B" | "C"; url: string; label: string }[] = [];
    if (effectiveConcept.imageUrlA)
      v.push({ key: "A", url: effectiveConcept.imageUrlA, label: "Clean / Commercial" });
    if (effectiveConcept.imageUrlB)
      v.push({ key: "B", url: effectiveConcept.imageUrlB, label: "Bold / Artistic" });
    if (effectiveConcept.imageUrlC)
      v.push({ key: "C", url: effectiveConcept.imageUrlC, label: "Trending / Social" });
    return v;
  }, [effectiveConcept]);

  const isLoading = latestRunQuery.isLoading || reviewQueueQuery.isLoading ||
    (!!urlConceptId && singleConceptQuery.isLoading);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Design Studio</h1>
          <p className="text-muted-foreground">Loading concepts...</p>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  if (concepts.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Design Studio</h1>
          <p className="text-muted-foreground">
            Revise and iterate on your winning design concepts.
          </p>
        </div>
        <Card>
          <CardContent className="py-16 text-center">
            <Paintbrush className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold">No Designs to Review</h3>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              {urlConceptId
                ? "This concept doesn't have any generated images yet. Run the pipeline or approve a pattern first."
                : "Run the pipeline first to generate winning concepts with AI images. Only concepts with generated images appear here."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">Design Studio</h1>
        <p className="text-muted-foreground">
          {urlConceptId
            ? "Editing a single concept. Use natural language to revise any variation."
            : "Select a concept, then revise any variation with natural language instructions."}
        </p>
      </div>

      {/* Concept selector — only show if multiple concepts */}
      {concepts.length > 1 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Select Concept
          </h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {concepts.map((concept) => {
              const isSelected = effectiveConcept?.id === concept.id;
              const imageCount = [concept.imageUrlA, concept.imageUrlB, concept.imageUrlC].filter(Boolean).length;
              return (
                <button
                  key={concept.id}
                  onClick={() => setSelectedConceptId(concept.id)}
                  className={`flex-shrink-0 w-56 text-left rounded-lg border-2 p-3 transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-border hover:border-primary/40 bg-card"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {/* Thumbnail */}
                    {concept.imageUrlA ? (
                      <img
                        src={concept.imageUrlA}
                        alt={concept.conceptName}
                        className="w-12 h-12 rounded object-contain border bg-muted/30"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded border bg-muted/30 flex items-center justify-center">
                        <ImageIcon className="h-5 w-5 text-muted-foreground/40" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{concept.conceptName}</p>
                      <div className="flex items-center gap-1 mt-1">
                        {concept.isWinner && (
                          <Trophy className="h-3 w-3 text-amber-500" />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {imageCount} variation{imageCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${concept.conceptName}"? This cannot be undone.`)) {
                          deleteConceptMut.mutate({ conceptId: concept.id });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Variation tabs + revision panel */}
      {effectiveConcept && variations.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Paintbrush className="h-5 w-5" />
              {effectiveConcept.conceptName}
              {effectiveConcept.isWinner && (
                <Badge className="bg-amber-100 text-amber-800 text-xs">
                  <Trophy className="h-3 w-3 mr-1" />
                  Winner #{effectiveConcept.globalRank}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={variations[0].key}>
              <TabsList>
                {variations.map((v) => (
                  <TabsTrigger key={v.key} value={v.key}>
                    Variation {v.key}
                  </TabsTrigger>
                ))}
              </TabsList>
              {variations.map((v) => (
                <TabsContent key={v.key} value={v.key} className="mt-4">
                  <RevisionPanel
                    conceptId={effectiveConcept.id}
                    variationKey={v.key}
                    originalImageUrl={v.url}
                    conceptName={effectiveConcept.conceptName}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
