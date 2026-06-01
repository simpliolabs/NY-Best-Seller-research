/**
 * Mockups Page — Phase H
 * Shows generated mockup composites for design concepts.
 * Allows triggering mockup generation for a concept + variation + product group.
 */
import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Image as ImageIcon, Shirt, RefreshCw, Trash2 } from "lucide-react";

export default function Mockups() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id ?? "";

  // Read conceptId from URL search params (from Library "Send to Mockups" link)
  const searchString = useSearch();
  const urlConceptId = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return params.get("conceptId") ?? "";
  }, [searchString]);

  // State for generation form
  const [selectedConceptId, setSelectedConceptId] = useState<string>(urlConceptId);
  const [selectedVariation, setSelectedVariation] = useState<string>("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [colorCount, setColorCount] = useState<number>(5);

  // Fetch concepts that have images (all concepts, not just winners)
  const conceptsQuery = trpc.library.list.useQuery(
    { limit: 200, offset: 0, workspaceId, sortBy: "hasImages" as const, sortDir: "desc" as const },
    { enabled: !!workspaceId }
  );

  // Fetch product groups
  const groupsQuery = trpc.productGroup.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  // Fetch existing mockups for the selected concept
  const mockupsQuery = trpc.mockup.getMockups.useQuery(
    { conceptId: Number(selectedConceptId) },
    { enabled: !!selectedConceptId }
  );

  // Generate mutation
  const generateMutation = trpc.mockup.generate.useMutation({
    onSuccess: (data) => {
      // QA check data is internal-only — never surface scores/issues to user
      toast.success(`Generated ${data.mockupCount} mockup${data.mockupCount !== 1 ? "s" : ""}`);
      mockupsQuery.refetch();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Delete mutation
  const deleteMockup = trpc.mockup.deleteMockup.useMutation({
    onSuccess: () => {
      mockupsQuery.refetch();
      toast.success("Mockup deleted");
    },
    onError: (err) => toast.error(err.message),
  });

  // Filter concepts that have at least one image
  const conceptsWithImages = useMemo(() => {
    if (!conceptsQuery.data?.concepts) return [];
    return conceptsQuery.data.concepts.filter(
      (c) => c.imageUrlA || c.imageUrlB || c.imageUrlC
    );
  }, [conceptsQuery.data]);

  // Sync URL param once concepts load
  useEffect(() => {
    if (urlConceptId && conceptsWithImages.length > 0 && !selectedConceptId) {
      const found = conceptsWithImages.find((c) => c.id === Number(urlConceptId));
      if (found) {
        setSelectedConceptId(String(found.id));
      }
    }
  }, [urlConceptId, conceptsWithImages, selectedConceptId]);

  // Get available variations for selected concept
  const availableVariations = useMemo(() => {
    if (!selectedConceptId) return [];
    const concept = conceptsWithImages.find((c) => c.id === Number(selectedConceptId));
    if (!concept) return [];
    const vars: string[] = [];
    if (concept.imageUrlA) vars.push("A");
    if (concept.imageUrlB) vars.push("B");
    if (concept.imageUrlC) vars.push("C");
    return vars;
  }, [selectedConceptId, conceptsWithImages]);

  const canGenerate =
    selectedConceptId && selectedVariation && selectedGroupId && !generateMutation.isPending;

  function handleGenerate() {
    if (!canGenerate) return;
    generateMutation.mutate({
      conceptId: Number(selectedConceptId),
      variationKey: selectedVariation as "A" | "B" | "C",
      productGroupId: selectedGroupId,
      colorCount,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-['Syne'] tracking-tight">Mockups</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate product mockups by compositing your designs onto blank shirt templates.
        </p>
      </div>

      {/* Generation Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-['Syne'] flex items-center gap-2">
            <Shirt className="h-4 w-4" />
            Generate Mockups
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Concept selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Concept
              </label>
              <Select value={selectedConceptId} onValueChange={(v) => { setSelectedConceptId(v); setSelectedVariation(""); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select concept…" />
                </SelectTrigger>
                <SelectContent>
                  {conceptsWithImages.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.conceptName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Variation selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Variation
              </label>
              <Select
                value={selectedVariation}
                onValueChange={setSelectedVariation}
                disabled={!selectedConceptId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="A / B / C" />
                </SelectTrigger>
                <SelectContent>
                  {availableVariations.map((v) => (
                    <SelectItem key={v} value={v}>
                      Variation {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Product group selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Product Group
              </label>
              <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select group…" />
                </SelectTrigger>
                <SelectContent>
                  {groupsQuery.data?.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Color count */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Colors (max)
              </label>
              <Select value={String(colorCount)} onValueChange={(v) => setColorCount(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[3, 5, 8, 10, 15, 20].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} colors
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button onClick={handleGenerate} disabled={!canGenerate} className="w-full sm:w-auto">
            {generateMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Generating…
              </>
            ) : (
              <>
                <ImageIcon className="h-4 w-4 mr-2" />
                Generate Mockups
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Mockup Gallery */}
      {selectedConceptId && mockupsQuery.data && mockupsQuery.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-['Syne'] flex items-center gap-2">
              <ImageIcon className="h-4 w-4" />
              Generated Mockups ({mockupsQuery.data.length})
              <Button
                variant="ghost"
                size="sm"
                onClick={() => mockupsQuery.refetch()}
                className="ml-auto"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {mockupsQuery.data.map((mockup) => (
                <div
                  key={mockup.id}
                  className="group relative rounded-lg overflow-hidden border bg-muted/30"
                >
                  <img
                    src={mockup.compositeUrl}
                    alt={`Mockup ${mockup.variationKey}`}
                    className="w-full aspect-square object-contain"
                    loading="lazy"
                  />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-between">
                    <span className="text-xs text-white font-medium">
                      Var {mockup.variationKey}
                    </span>
                    <button
                      onClick={() => {
                        if (confirm("Delete this mockup?")) {
                          deleteMockup.mutate({ mockupId: mockup.id });
                        }
                      }}
                      className="p-1 rounded bg-red-600 hover:bg-red-700 text-white"
                      title="Delete mockup"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {selectedConceptId && mockupsQuery.data && mockupsQuery.data.length === 0 && !generateMutation.isPending && (
        <div className="text-center py-12 text-muted-foreground">
          <Shirt className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No mockups generated yet for this concept.</p>
          <p className="text-xs mt-1">Select a variation and product group, then click Generate.</p>
        </div>
      )}

      {!selectedConceptId && (
        <div className="text-center py-12 text-muted-foreground">
          <Shirt className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Select a concept above to view or generate mockups.</p>
        </div>
      )}
    </div>
  );
}
