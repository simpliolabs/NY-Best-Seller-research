import { useState, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { ImageThumbnail } from "@/components/ImageThumbnail";
import { ImageLightbox } from "@/components/ImageLightbox";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LayoutGrid, List, ChevronDown, ChevronRight, BookOpen, Zap, ExternalLink, Trash2, Paintbrush, Wand2, Shirt, Loader2, Upload, Pencil } from "lucide-react";
import { Link } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "sonner";

const PAGE_SIZE = 24;

type ViewMode = "grid" | "byBook";

export default function Library() {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const [offset, setOffset] = useState(0);
  const [bookTitle, setBookTitle] = useState("");
  const [winnersOnly, setWinnersOnly] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState("");
  const [selectedStyle, setSelectedStyle] = useState("");
  const [selectedFramework, setSelectedFramework] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "score" | "rank" | "hasImages">("date");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [viewMode, setViewMode] = useState<ViewMode>("byBook");

  // Lightbox state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxConcept, setLightboxConcept] = useState<any>(null);

  // Upload state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const uploadMutation = trpc.library.uploadConcept.useMutation({
    onSuccess: () => {
      toast.success("Design uploaded!");
      utils.library.list.invalidate();
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
    },
    onError: (err) => toast.error(err.message),
  });

  function handleUploadSubmit() {
    if (!uploadFile || !uploadName.trim() || !workspaceId) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      uploadMutation.mutate({
        workspaceId,
        name: uploadName.trim(),
        imageBase64: base64,
        mimeType: uploadFile.type as "image/png" | "image/jpeg" | "image/webp",
      });
    };
    reader.readAsDataURL(uploadFile);
  }

  // Expanded books in group-by-book view
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());

  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const workspaceId = activeWorkspace?.id;

  const filters = useMemo(() => ({
    limit: viewMode === "byBook" ? 100 : PAGE_SIZE, // fetch more for grouping
    offset: viewMode === "byBook" ? 0 : offset,
    workspaceId: workspaceId || undefined,
    bookTitle: bookTitle || undefined,
    winnersOnly: winnersOnly || undefined,
    format: selectedFormat || undefined,
    style: selectedStyle || undefined,
    humorFramework: selectedFramework || undefined,
    sortBy,
    sortDir,
  }), [offset, workspaceId, bookTitle, winnersOnly, selectedFormat, selectedStyle, selectedFramework, sortBy, sortDir, viewMode]);

  const { data, isLoading } = trpc.library.list.useQuery(filters);
  const { data: filterOptions } = trpc.library.getFilterOptions.useQuery(
    workspaceId ? { workspaceId } : undefined
  );

  const concepts = data?.concepts ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // Group concepts by book title for the byBook view
  const groupedByBook = useMemo(() => {
    const groups: Record<string, { bookTitle: string; bookAuthor: string; concepts: any[] }> = {};
    for (const c of concepts) {
      const key = c.bookTitle || "Unknown";
      if (!groups[key]) {
        groups[key] = { bookTitle: key, bookAuthor: c.bookAuthor || "", concepts: [] };
      }
      groups[key].concepts.push(c);
    }
    // Sort groups by number of concepts descending
    return Object.values(groups).sort((a, b) => b.concepts.length - a.concepts.length);
  }, [concepts]);

  const resetPagination = () => setOffset(0);

  const toggleBookExpand = (title: string) => {
    setExpandedBooks(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedBooks(new Set(groupedByBook.map(g => g.bookTitle)));
  };

  const collapseAll = () => {
    setExpandedBooks(new Set());
  };

  const openLightbox = (concept: any) => {
    setLightboxConcept(concept);
    setLightboxOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Concept Library</h1>
          <p className="text-muted-foreground mt-1">
            {total} concepts across all runs — browse, filter, and export production files
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* View mode toggle */}
          <div className="flex items-center border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode("byBook")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                viewMode === "byBook"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              <List className="h-4 w-4" /> {isNicheWorkspace ? "By Signal" : "By Book"}
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                viewMode === "grid"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              <LayoutGrid className="h-4 w-4" /> Grid
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUploadOpen(true)}
            className="gap-1.5"
          >
            <Upload className="h-4 w-4" />
            Upload Design
          </Button>
          <span className="font-mono bg-muted px-2 py-1 rounded text-sm text-muted-foreground">{total}</span>
        </div>
      </div>

      {/* Upload Dialog */}
      {uploadOpen && (
        <Card className="p-4 border-primary/30 bg-primary/5">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="space-y-1 flex-1 min-w-0">
              <label className="text-xs font-medium text-muted-foreground">Design Name</label>
              <input
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="e.g. My Custom Design"
                className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Image (PNG/JPEG/WebP)</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-2 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleUploadSubmit}
                disabled={!uploadFile || !uploadName.trim() || uploadMutation.isPending}
              >
                {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
                Upload
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setUploadOpen(false); setUploadName(""); setUploadFile(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Filters Bar */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Book dropdown filter */}
          <div className="min-w-[200px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">{isNicheWorkspace ? "Signal" : "Book"}</label>
            <select
              value={bookTitle}
              onChange={(e) => { setBookTitle(e.target.value); resetPagination(); }}
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            >
              <option value="">{isNicheWorkspace ? "All signals" : "All books"}</option>
              {filterOptions?.bookTitles?.map((t: string) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Format filter */}
          <div className="min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Format</label>
            <select
              value={selectedFormat}
              onChange={(e) => { setSelectedFormat(e.target.value); resetPagination(); }}
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            >
              <option value="">All formats</option>
              {filterOptions?.formats.map((f: string) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          {/* Style filter */}
          <div className="min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Style</label>
            <select
              value={selectedStyle}
              onChange={(e) => { setSelectedStyle(e.target.value); resetPagination(); }}
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            >
              <option value="">All styles</option>
              {filterOptions?.styles.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Framework filter */}
          <div className="min-w-[160px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Framework</label>
            <select
              value={selectedFramework}
              onChange={(e) => { setSelectedFramework(e.target.value); resetPagination(); }}
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            >
              <option value="">All frameworks</option>
              {filterOptions?.humorFrameworks.map((h: string) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>

          {/* Sort */}
          <div className="min-w-[120px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Sort by</label>
            <select
              value={`${sortBy}-${sortDir}`}
              onChange={(e) => {
                const [s, d] = e.target.value.split("-") as [typeof sortBy, typeof sortDir];
                setSortBy(s);
                setSortDir(d);
                resetPagination();
              }}
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            >
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="score-desc">Highest score</option>
              <option value="score-asc">Lowest score</option>
              <option value="hasImages-desc">Has images first</option>
            </select>
          </div>

          {/* Winners toggle */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer h-9">
              <input
                type="checkbox"
                checked={winnersOnly}
                onChange={(e) => { setWinnersOnly(e.target.checked); resetPagination(); }}
                className="rounded border-input"
              />
              <span className="text-sm font-medium">Winners only</span>
            </label>
          </div>
        </div>
      </Card>

      {/* Loading */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 15 }).map((_, i) => (
            <div key={i} className="h-[280px] bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : concepts.length === 0 ? (
        <Card className="p-12 text-center">
          <BookOpen className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground">No concepts found. Run the pipeline to generate concepts.</p>
        </Card>
      ) : viewMode === "byBook" ? (
        /* ─── GROUP BY BOOK VIEW ─── */
        <div className="space-y-4">
          {/* Expand/collapse controls */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={expandAll}>Expand All</Button>
            <Button variant="outline" size="sm" onClick={collapseAll}>Collapse All</Button>
          </div>

          {groupedByBook.map((group) => {
            const isExpanded = expandedBooks.has(group.bookTitle);
            const winnerCount = group.concepts.filter((c: any) => c.isWinner).length;
            const imageCount = group.concepts.filter((c: any) => c.productionUrlA || c.imageUrlA || c.productionUrlB || c.imageUrlB || c.productionUrlC || c.imageUrlC).length;

            return (
              <Card key={group.bookTitle} className="overflow-hidden">
                {/* Book header - clickable to expand/collapse */}
                <button
                  onClick={() => toggleBookExpand(group.bookTitle)}
                  className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                  )}
                  {isNicheWorkspace ? <Zap className="h-5 w-5 text-primary shrink-0" /> : <BookOpen className="h-5 w-5 text-primary shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate">{group.bookTitle}</h3>
                    <p className="text-xs text-muted-foreground">{group.bookAuthor}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {group.concepts[0]?.bookId && (
                      <Link
                        href={`/${slug}/book/${group.concepts[0].bookId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-primary hover:underline flex items-center gap-0.5 px-2 py-1 rounded-md hover:bg-primary/10 transition-colors"
                      >
                        {isNicheWorkspace ? "View Signal" : "View Book"} <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                    <Badge variant="secondary" className="text-xs">
                      {group.concepts.length} concepts
                    </Badge>
                    {winnerCount > 0 && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-xs">
                        {winnerCount} winner{winnerCount > 1 ? "s" : ""}
                      </Badge>
                    )}
                    {imageCount > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {imageCount} with images
                      </Badge>
                    )}
                  </div>
                </button>

                {/* Expanded concept grid */}
                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-3">
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {group.concepts.map((concept: any) => (
                        <ConceptCard
                          key={concept.id}
                          concept={concept}
                          onOpenLightbox={() => openLightbox(concept)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        /* ─── FLAT GRID VIEW ─── */
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {concepts.map((concept) => (
              <ConceptCard
                key={concept.id}
                concept={concept}
                onOpenLightbox={() => openLightbox(concept)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 1}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground px-4">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
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
            bookTitle: lightboxConcept.bookTitle,
            bookAuthor: lightboxConcept.bookAuthor,
            bookId: lightboxConcept.bookId ?? null,
            imagePromptA: lightboxConcept.imagePromptA,
            imagePromptB: lightboxConcept.imagePromptB,
            imagePromptC: lightboxConcept.imagePromptC,
            signalTags: Array.isArray(lightboxConcept.signalTags) ? lightboxConcept.signalTags : [],
            sourcePhrase: lightboxConcept.sourcePhrase ?? null,
            bookSocialMomentum: lightboxConcept.bookSocialMomentum ?? null,
            bookSocialRationale: lightboxConcept.bookSocialRationale ?? null,
            bookDesignNovelty: lightboxConcept.bookDesignNovelty ?? null,
            bookDesignRationale: lightboxConcept.bookDesignRationale ?? null,
            bookAudienceSize: lightboxConcept.bookAudienceSize ?? null,
            bookAudienceRationale: lightboxConcept.bookAudienceRationale ?? null,
          }}
        />
      )}
    </div>
  );
}

// ─── Concept Card (fixed image heights) ──────────────────────────────────

function ConceptCard({ concept, onOpenLightbox, onDeleted }: { concept: any; onOpenLightbox: () => void; onDeleted?: (id: number) => void }) {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const hasImage = concept.productionUrlA || concept.imageUrlA || concept.productionUrlB || concept.imageUrlB || concept.productionUrlC || concept.imageUrlC;
  const primaryImage = concept.productionUrlA || concept.imageUrlA || concept.productionUrlB || concept.imageUrlB || concept.productionUrlC || concept.imageUrlC;
  const imageCount = [concept.productionUrlA || concept.imageUrlA, concept.productionUrlB || concept.imageUrlB, concept.productionUrlC || concept.imageUrlC].filter(Boolean).length;
  const utils = trpc.useUtils();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(concept.conceptName ?? "");
  const renameMutation = trpc.concepts.rename.useMutation({
    onSuccess: () => { toast.success("Renamed"); utils.library.list.invalidate(); setIsRenaming(false); },
    onError: (err: any) => toast.error(err.message),
  });
  const deleteMutation = trpc.library.deleteConcept.useMutation({
    onSuccess: () => {
      onDeleted?.(concept.id);
      utils.library.list.invalidate();
    },
  });
  const generateImageMut = trpc.concepts.generateSingleImage.useMutation({
    onSuccess: (res: any) => {
      if (res.success) {
        toast.success("Images generated!");
        utils.library.list.invalidate();
      } else {
        toast.error(res.message || "Image generation failed");
      }
    },
    onError: (err: any) => toast.error(err.message),
  });

  return (
    <Card
      className="overflow-hidden group hover:shadow-lg transition-shadow cursor-pointer flex flex-col"
      onClick={onOpenLightbox}
    >
      {/* Image area — FIXED HEIGHT, never stretches */}
      <div className="h-[160px] relative bg-muted shrink-0">
        {hasImage ? (
          <img
            src={primaryImage}
            alt={concept.conceptName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center p-3">
              {concept.colorPalette && concept.colorPalette.length > 0 && (
                <div className="flex gap-1.5 justify-center mb-2">
                  {concept.colorPalette.slice(0, 4).map((c: string, i: number) => (
                    <div key={i} className="w-7 h-7 rounded-full border border-white/20 shadow-sm" style={{ backgroundColor: c }} />
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground font-medium">{concept.format}</p>
              <p className="text-[11px] text-muted-foreground">{concept.style}</p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  generateImageMut.mutate({ conceptId: concept.id });
                }}
                disabled={generateImageMut.isPending}
                className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Wand2 className="h-3 w-3" />
                {generateImageMut.isPending ? "Generating..." : "Generate Image"}
              </button>
            </div>
          </div>
        )}

        {/* Winner badge overlay */}
        {concept.isWinner && (
          <div className="absolute top-2 left-2 flex flex-col gap-1">
            <div className="flex items-center gap-1 bg-amber-500 text-white px-2 py-0.5 rounded-full text-[10px] font-bold shadow-lg">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              #{concept.globalRank}
            </div>
            {concept.runDate && (
              <div className="bg-black/60 text-white px-1.5 py-0.5 rounded text-[9px] font-medium w-fit">
                {new Date(concept.runDate).toLocaleDateString()}
              </div>
            )}
          </div>
        )}

        {/* Image count badge */}
        {imageCount > 0 && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/60 text-white px-1.5 py-0.5 rounded text-[10px]">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {imageCount}
          </div>
        )}

        {/* Refresh source badge */}
        {concept.refreshSource === "book_refresh" && (
          <div className="absolute top-2 right-2 bg-blue-500 text-white px-1.5 py-0.5 rounded text-[10px] font-bold">
            New
          </div>
        )}

        {/* Delete button — top-right, visible on hover */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${concept.conceptName}"? This cannot be undone.`)) {
              deleteMutation.mutate({ conceptId: concept.id });
            }
          }}
          disabled={deleteMutation.isPending}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 hover:bg-red-700 text-white p-1 rounded-full shadow-lg z-10"
          title="Delete concept"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Info area */}
      <div className="p-3 space-y-1.5 flex-1">
        <div className="flex items-center justify-between">
          {isRenaming ? (
            <form className="flex-1 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const v = renameValue.trim(); if (v && v.length <= 120) renameMutation.mutate({ conceptId: concept.id, name: v }); }}>
              <input autoFocus className="flex-1 text-sm border rounded px-1.5 py-0.5 bg-background" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={120} onClick={(e) => e.stopPropagation()} />
              <button type="submit" className="text-xs text-primary font-medium" onClick={(e) => e.stopPropagation()} disabled={renameMutation.isPending}>Save</button>
              <button type="button" className="text-xs text-muted-foreground" onClick={(e) => { e.stopPropagation(); setIsRenaming(false); setRenameValue(concept.conceptName); }}>Cancel</button>
            </form>
          ) : (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-foreground truncate">{concept.conceptName}</h4>
              <button onClick={(e) => { e.stopPropagation(); setRenameValue(concept.conceptName); setIsRenaming(true); }} className="shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Rename">
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-0.5 shrink-0 ml-1">
            {hasImage ? (
              <>
                <Link
                  href={`/${slug}/design-studio?conceptId=${concept.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                  title="Edit in Design Studio"
                >
                  <Paintbrush className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href={`/${slug}/mockups?conceptId=${concept.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                  title="Generate product mockups"
                >
                  <Shirt className="h-3.5 w-3.5" />
                </Link>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toast.info("Generating images... this takes 15-30 seconds.");
                  generateImageMut.mutate({ conceptId: concept.id });
                }}
                disabled={generateImageMut.isPending}
                className="p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                title="Generate images for this concept"
              >
                {generateImageMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {concept.bookId ? (
            <Link
              href={`/${slug}/book/${concept.bookId}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {concept.bookTitle}
            </Link>
          ) : (
            <span>{concept.bookTitle}</span>
          )}
          {" "} — {concept.format}
        </p>
        <div className="flex items-center justify-between">
          {concept.trendScore ? (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-14 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                  style={{ width: `${Math.min(100, (concept.trendScore / 300) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{concept.trendScore}</span>
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground">No score</span>
          )}
          <span className="text-[10px] text-muted-foreground truncate ml-1">
            {concept.humorFramework ?? concept.style}
          </span>
        </div>
      </div>
    </Card>
  );
}
