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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PrintZoneEditor } from "@/components/PrintZoneEditor";
import type { PrintZoneCoords } from "@/components/PrintZoneEditor";
import { MockupLightbox } from "@/components/MockupLightbox";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Loader2, Image as ImageIcon, Shirt, RefreshCw, Trash2, AlertTriangle, Move, Check, X } from "lucide-react";


export default function Mockups() {
  const [zoomMockupUrl, setZoomMockupUrl] = useState<string | null>(null);
  const [conceptSearch, setConceptSearch] = useState("");
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id ?? "";

  // Read conceptId + revisionId from URL search params
  const searchString = useSearch();
  const urlConceptId = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return params.get("conceptId") ?? "";
  }, [searchString]);
  const revisionId = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return params.get("revisionId") ?? undefined;
  }, [searchString]);
  const regenerate = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return params.get("regenerate") === "1";
  }, [searchString]);

  // State for generation form
  const [selectedConceptId, setSelectedConceptId] = useState<string>(urlConceptId);
  const [selectedVariation, setSelectedVariation] = useState<string>("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [colorCount, setColorCount] = useState<number>(5);

  // Track whether the last generation used a default zone
  const [usedDefaultZone, setUsedDefaultZone] = useState<boolean>(false);


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

  // Filter mockups by revisionId when present (per-design identity)
  const filteredMockups = useMemo(() => {
    if (!mockupsQuery.data) return [];
    if (!revisionId) {
      // Live-slot: show only NULL-sourceRevisionId renders
      return mockupsQuery.data.filter((m) => !m.sourceRevisionId);
    }
    return mockupsQuery.data.filter((m) => m.sourceRevisionId === revisionId);
  }, [mockupsQuery.data, revisionId]);

  // Fetch revision name when revisionId is in URL
  const revisionHistoryQuery = trpc.concepts.getGenerationHistory.useQuery(
    { conceptId: Number(selectedConceptId) },
    { enabled: !!selectedConceptId && !!revisionId }
  );
  const revisionName = useMemo(() => {
    if (!revisionId || !revisionHistoryQuery.data) return undefined;
    const allRevs = revisionHistoryQuery.data;
    const revIdx = allRevs.findIndex((r) => r.id === revisionId);
    if (revIdx === -1) return undefined;
    const rev = allRevs[revIdx];
    // Derive version label: oldest = V1, newest history = V(total-1), live = V(total)
    const totalVersions = allRevs.length + 1;
    const versionNumber = totalVersions - 1 - revIdx;
    const selectedConcept = (conceptsQuery.data?.concepts ?? []).find((c: any) => String(c.id) === selectedConceptId);
    const cName = selectedConcept?.conceptName ?? "Concept";
    return rev.name ?? `${cName} V${versionNumber}`;
  }, [revisionId, revisionHistoryQuery.data, conceptsQuery.data, selectedConceptId]);

  // Generate mutation
  const generateMutation = trpc.mockup.generate.useMutation({
    onSuccess: (data) => {
      // Surface usedDefaultZone flag
      setUsedDefaultZone(!!data.usedDefaultZone);
      if (data.failedCount && data.failedCount > 0) {
        const total = data.mockupCount + data.failedCount;
        toast.warning(`${data.failedCount} of ${total} templates failed`);
      } else {
        toast.success(`Generated ${data.mockupCount} mockup${data.mockupCount !== 1 ? "s" : ""}`);
      }
      mockupsQuery.refetch();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Print export mutations
  const exportPrintMutation = trpc.mockup.exportPrintFile.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const halftoneMutation = trpc.mockup.generateHalftone.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const [inkColor, setInkColor] = useState<
    "black" | "white" | "navy" | "red" | "forest" | "maroon" | "gold"
  >("black");

  // Delete mutation
  const deleteMockup = trpc.mockup.deleteMockup.useMutation({
    onSuccess: () => {
      mockupsQuery.refetch();
      toast.success("Mockup deleted");
    },
    onError: (err) => toast.error(err.message),
  });

  // Manual Placement state
  const [placementDialogOpen, setPlacementDialogOpen] = useState(false);
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState(0);

  // Fetch group detail (always when group selected, so button can reflect placement state)
  const groupDetail = trpc.productGroup.get.useQuery(
    { groupId: selectedGroupId! },
    { enabled: !!selectedGroupId }
  );

  // Per-design placement (concept + group)
  const placementQuery = trpc.mockup.getConceptPlacement.useQuery(
    { conceptId: Number(selectedConceptId!), productGroupId: selectedGroupId! },
    { enabled: !!selectedConceptId && !!selectedGroupId }
  );
  const hasManualPlacement = !!placementQuery.data;

  // Manual placement mutations
  const setPlacement = trpc.mockup.setConceptPlacement.useMutation();
  const utils = trpc.useUtils();

  const conceptsWithImages = useMemo(() => {
    if (!conceptsQuery.data?.concepts) return [];
    return conceptsQuery.data.concepts.filter(
      (c) => c.imageUrlA || c.imageUrlB || c.imageUrlC
    );
  }, [conceptsQuery.data]);

  // Filtered concepts for search box
  const filteredConcepts = useMemo(() => {
    const q = conceptSearch.trim().toLowerCase();
    if (!q) return conceptsWithImages;
    return conceptsWithImages.filter((c) =>
      (c.conceptName ?? "").toLowerCase().includes(q) ||
      ((c as any).signal ?? "").toString().toLowerCase().includes(q) ||
      ((c as any).style ?? "").toString().toLowerCase().includes(q)
    );
  }, [conceptsWithImages, conceptSearch]);

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
    // Clear previous warning state
    setUsedDefaultZone(false);
    generateMutation.mutate({
      conceptId: Number(selectedConceptId),
      variationKey: selectedVariation as "A" | "B" | "C",
      productGroupId: selectedGroupId,
      colorCount,
      ...(revisionId ? { sourceRevisionId: revisionId } : {}),
      ...(regenerate ? { regenerateProduction: true } : {}),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-['Syne'] tracking-tight">
          Mockups{revisionName ? ` · ${revisionName}` : ""}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {revisionId
            ? "Generating mockups for a specific design version. These won\u2019t replace the live-slot mockups."
            : "Generate product mockups by compositing your designs onto blank shirt templates."}
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
            <div className="space-y-1.5 min-w-0">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Concept
              </label>
              <Input
                value={conceptSearch}
                onChange={(e) => setConceptSearch(e.target.value)}
                placeholder="Search concepts…"
                className="mb-1.5 h-8 text-sm"
              />
              <Select value={selectedConceptId} onValueChange={(v) => { setSelectedConceptId(v); setSelectedVariation(""); }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select concept…" className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {filteredConcepts.map((c) => (
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
            <div className="space-y-1.5 min-w-0">
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
                  {[3, 5, 6, 7, 8, 10, 15, 20].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} colors
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
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
            <Button
              variant="outline"
              disabled={!selectedGroupId}
              onClick={() => {
                setSelectedTemplateIdx(0);
                setPlacementDialogOpen(true);
              }}
              className="w-full sm:w-auto"
            >
              {hasManualPlacement ? (
                <>
                  <Check className="h-4 w-4 mr-1 text-green-600" />
                  Manual Placement (active)
                </>
              ) : (
                <>
                  <Move className="h-4 w-4 mr-1" />
                  Manual Placement
                </>
              )}
            </Button>
            {hasManualPlacement && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                disabled={setPlacement.isPending}
                onClick={async () => {
                  if (!window.confirm("Remove this design's manual placement? Mockups revert to the group calibration.")) return;
                  await setPlacement.mutateAsync({ conceptId: Number(selectedConceptId!), productGroupId: selectedGroupId!, printArea: null });
                  toast.success("Manual placement removed \u2014 mockups revert to group calibration");
                  utils.mockup.getConceptPlacement.invalidate({ conceptId: Number(selectedConceptId!), productGroupId: selectedGroupId! });
                }}
              >
                <X className="h-4 w-4 mr-1" /> Remove placement
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Warning banner: usedDefaultZone */}
      {usedDefaultZone && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200">
            <span className="font-semibold">No print zone set for this group</span> — using default.
            Draw one for precise placement.
          </div>
        </div>
      )}



      {/* Mockup Gallery */}
      {selectedConceptId && filteredMockups.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-['Syne'] flex items-center gap-2">
              <ImageIcon className="h-4 w-4" />
              Generated Mockups ({filteredMockups.length})
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canGenerate}
                  onClick={handleGenerate}
                  title="Regenerate mockups with current settings"
                >
                  {generateMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  )}
                  Regenerate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => mockupsQuery.refetch()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredMockups.map((mockup) => (
                <div
                  key={mockup.id}
                  className="group relative rounded-lg overflow-hidden border bg-muted/30"
                >
                  <img
                    src={mockup.compositeUrl}
                    alt={`Mockup ${mockup.variationKey}`}
                    className="w-full aspect-square object-contain cursor-zoom-in"
                    loading="lazy"
                    onClick={() => setZoomMockupUrl(mockup.compositeUrl)}
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

      {/* Print files panel */}
      {!!selectedConceptId && (
        <div className="mt-4 p-3 rounded-lg border bg-slate-50">
          <h3 className="text-sm font-semibold mb-2">Print files — 300 DPI</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline" size="sm"
              disabled={exportPrintMutation.isPending}
              onClick={() => exportPrintMutation.mutate({
                conceptId: Number(selectedConceptId),
                variationKey: (selectedVariation || "A") as "A" | "B" | "C",
                ...(revisionId ? { sourceRevisionId: revisionId } : {}),
              })}
            >
              {exportPrintMutation.isPending ? "Preparing…" : "Download print file"}
            </Button>

            <select
              value={inkColor}
              onChange={(e) => setInkColor(e.target.value as typeof inkColor)}
              className="text-xs border rounded px-2 py-1 bg-white"
            >
              <option value="black">Black ink</option>
              <option value="white">White ink</option>
              <option value="navy">Navy ink</option>
              <option value="red">Red ink</option>
              <option value="forest">Forest ink</option>
              <option value="maroon">Maroon ink</option>
              <option value="gold">Gold ink</option>
            </select>
            <Button
              variant="outline" size="sm"
              disabled={halftoneMutation.isPending}
              onClick={() => halftoneMutation.mutate({
                conceptId: Number(selectedConceptId),
                variationKey: (selectedVariation || "A") as "A" | "B" | "C",
                ...(revisionId ? { sourceRevisionId: revisionId } : {}),
                inkColors: [inkColor],
                lpi: 45,
              })}
            >
              {halftoneMutation.isPending ? "Rendering…" : "Generate halftone"}
            </Button>
          </div>

          {exportPrintMutation.data && (
            <a
              href={exportPrintMutation.data.url}
              download={exportPrintMutation.data.filename}
              className="block mt-2 text-sm text-blue-600 underline"
            >
              ⬇ {exportPrintMutation.data.filename} — {exportPrintMutation.data.widthPx}×{exportPrintMutation.data.heightPx}, 300 DPI
            </a>
          )}

          {halftoneMutation.data && (
            <div className="mt-2 space-y-1">
              {halftoneMutation.data.results.map((r) => (
                <div key={r.inkColor} className="flex items-center gap-2">
                  <img src={r.url} alt={r.inkColor}
                       className="h-12 w-12 object-contain border bg-white rounded" />
                  <a href={r.url} download={r.filename}
                     className="text-sm text-blue-600 underline">⬇ {r.filename}</a>
                </div>
              ))}
              <p className="text-[11px] text-amber-700">{halftoneMutation.data.note}</p>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {selectedConceptId && mockupsQuery.data && filteredMockups.length === 0 && !generateMutation.isPending && (
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
      {/* Manual Placement Dialog */}
      <Dialog open={placementDialogOpen} onOpenChange={setPlacementDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-['Syne']">Manual Placement</DialogTitle>
          </DialogHeader>
          {groupDetail.data?.mockups && groupDetail.data.mockups.length > 0 ? (
            <div className="space-y-4">
              {/* Color picker */}
              <div className="flex flex-wrap gap-2">
                {groupDetail.data.mockups.map((t, idx) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTemplateIdx(idx)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                      idx === selectedTemplateIdx
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-full border"
                      style={{ backgroundColor: t.colorHex }}
                    />
                    {t.colorName}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Applies to THIS design only \u2014 garment print areas are calibrated on the Product Groups page.
              </p>
              {/* PrintZoneEditor */}
              <PrintZoneEditor
                imageUrl={groupDetail.data.mockups[selectedTemplateIdx].imageUrl}
                initialZone={placementQuery.data ?? null}
                saving={setPlacement.isPending}
                onCancel={() => setPlacementDialogOpen(false)}
                onSave={async (zone: PrintZoneCoords) => {
                  await setPlacement.mutateAsync({
                    conceptId: Number(selectedConceptId!),
                    productGroupId: selectedGroupId!,
                    printArea: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
                  });
                  utils.mockup.getConceptPlacement.invalidate({ conceptId: Number(selectedConceptId!), productGroupId: selectedGroupId! });
                  setPlacementDialogOpen(false);
                  toast.success("Placement saved for this design");
                }}
              />

            </div>
          ) : groupDetail.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No color templates found for this group. Upload mockup templates first.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <MockupLightbox src={zoomMockupUrl} onClose={() => setZoomMockupUrl(null)} />
    </div>
  );
}
