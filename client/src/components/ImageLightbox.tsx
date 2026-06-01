import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link, useLocation } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Shirt, Paintbrush } from "lucide-react";

type Variation = "A" | "B" | "C";

interface ConceptDetail {
  headline?: string | null;
  subtext?: string | null;
  layoutDescription?: string | null;
  fontSuggestion?: string | null;
  colorPalette?: string[] | null;
  format?: string | null;
  style?: string | null;
  humorFramework?: string | null;
  trendScore?: number | null;
  isWinner?: boolean | null;
  globalRank?: number | null;
  bookTitle?: string | null;
  bookAuthor?: string | null;
  bookId?: number | null;
  imagePromptA?: string | null;
  imagePromptB?: string | null;
  imagePromptC?: string | null;
  signalTags?: string[] | null;
  sourcePhrase?: string | null;
  // Book-level scoring breakdown
  bookSocialMomentum?: number | null;
  bookSocialRationale?: string | null;
  bookDesignNovelty?: number | null;
  bookDesignRationale?: string | null;
  bookAudienceSize?: number | null;
  bookAudienceRationale?: string | null;
}

interface ImageLightboxProps {
  isOpen: boolean;
  onClose: () => void;
  conceptId: number;
  conceptName: string;
  images: {
    A: string | null | undefined;
    B: string | null | undefined;
    C: string | null | undefined;
  };
  labels?: {
    A?: string;
    B?: string;
    C?: string;
  };
  detail?: ConceptDetail;
}

const DEFAULT_LABELS = {
  A: "Clean / Commercial",
  B: "Bold / Artistic",
  C: "Trending / Social",
};

const PROMPT_LABELS: Record<Variation, "imagePromptA" | "imagePromptB" | "imagePromptC"> = {
  A: "imagePromptA",
  B: "imagePromptB",
  C: "imagePromptC",
};

export function ImageLightbox({ isOpen, onClose, conceptId, conceptName, images, labels, detail: externalDetail }: ImageLightboxProps) {
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const [activeVariation, setActiveVariation] = useState<Variation>("A");
  const [exporting, setExporting] = useState<Variation | null>(null);

  const effectiveLabels = { ...DEFAULT_LABELS, ...labels };
  const exportMutation = trpc.concepts.exportProduction.useMutation();

  // Auto-fetch concept detail if not provided externally
  const needsFetch = isOpen && !externalDetail;
  const { data: fetchedConcept } = trpc.concepts.getById.useQuery(
    { conceptId },
    { enabled: needsFetch }
  );

  // Use external detail if provided, otherwise use fetched data
  const detail: ConceptDetail | undefined = externalDetail ?? (fetchedConcept ? {
    headline: fetchedConcept.headline,
    subtext: fetchedConcept.subtext,
    layoutDescription: fetchedConcept.layoutDescription,
    fontSuggestion: fetchedConcept.fontSuggestion,
    colorPalette: fetchedConcept.colorPalette,
    format: fetchedConcept.format,
    style: fetchedConcept.style,
    humorFramework: fetchedConcept.humorFramework,
    trendScore: fetchedConcept.trendScore,
    isWinner: fetchedConcept.isWinner,
    globalRank: fetchedConcept.globalRank,
    bookTitle: fetchedConcept.bookTitle ?? null,
    bookAuthor: fetchedConcept.bookAuthor ?? null,
    bookId: fetchedConcept.bookId ?? null,
    imagePromptA: fetchedConcept.imagePromptA,
    imagePromptB: fetchedConcept.imagePromptB,
    imagePromptC: fetchedConcept.imagePromptC,
    signalTags: Array.isArray(fetchedConcept.signalTags) ? fetchedConcept.signalTags : [],
    sourcePhrase: fetchedConcept.sourcePhrase ?? null,
    bookSocialMomentum: fetchedConcept.bookSocialMomentum ?? null,
    bookSocialRationale: fetchedConcept.bookSocialRationale ?? null,
    bookDesignNovelty: fetchedConcept.bookDesignNovelty ?? null,
    bookDesignRationale: fetchedConcept.bookDesignRationale ?? null,
    bookAudienceSize: fetchedConcept.bookAudienceSize ?? null,
    bookAudienceRationale: fetchedConcept.bookAudienceRationale ?? null,
  } : undefined);

  const availableVariations = (["A", "B", "C"] as Variation[]).filter(v => images[v]);
  const hasAnyImage = availableVariations.length > 0;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowLeft") {
      const idx = availableVariations.indexOf(activeVariation);
      if (idx > 0) setActiveVariation(availableVariations[idx - 1]);
    }
    if (e.key === "ArrowRight") {
      const idx = availableVariations.indexOf(activeVariation);
      if (idx < availableVariations.length - 1) setActiveVariation(availableVariations[idx + 1]);
    }
  }, [isOpen, activeVariation, availableVariations, onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (isOpen && availableVariations.length > 0 && !images[activeVariation]) {
      setActiveVariation(availableVariations[0]);
    }
  }, [isOpen]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  if (!isOpen) return null;

  const currentImage = images[activeVariation];
  const currentPrompt = detail?.[PROMPT_LABELS[activeVariation]];

  const handleExport = async (variation: Variation) => {
    setExporting(variation);
    try {
      const result = await exportMutation.mutateAsync({ conceptId, variation });
      if (result.success && result.url) {
        const link = document.createElement("a");
        link.href = result.url;
        link.download = `${conceptName.replace(/[^a-zA-Z0-9]/g, "_")}_${variation}_production.png`;
        link.target = "_blank";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        alert(result.message || "Export failed");
      }
    } catch (err: any) {
      alert(err?.message || "Export failed");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Concept detail: ${conceptName}`}
    >
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-[#111] text-white shadow-2xl">

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">

          {/* ── Left: Image or placeholder ── */}
          <div className="flex flex-col bg-black/40 rounded-tl-2xl rounded-bl-2xl p-6 gap-4">

            {/* Variation tabs */}
            {hasAnyImage && (
              <div className="flex gap-2 flex-wrap">
                {availableVariations.map(v => (
                  <button
                    key={v}
                    onClick={() => setActiveVariation(v)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeVariation === v
                        ? "bg-white text-black shadow"
                        : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
                    }`}
                  >
                    {effectiveLabels[v]}
                  </button>
                ))}
              </div>
            )}

            {/* Image */}
            <div className="flex-1 flex items-center justify-center min-h-[280px] relative">
              {currentImage ? (
                <>
                  <img
                    src={currentImage}
                    alt={`${conceptName} — ${effectiveLabels[activeVariation]}`}
                    className="max-w-full max-h-[55vh] object-contain rounded-xl shadow-2xl"
                  />
                  {/* Arrows */}
                  {availableVariations.indexOf(activeVariation) > 0 && (
                    <button
                      onClick={() => setActiveVariation(availableVariations[availableVariations.indexOf(activeVariation) - 1])}
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                  )}
                  {availableVariations.indexOf(activeVariation) < availableVariations.length - 1 && (
                    <button
                      onClick={() => setActiveVariation(availableVariations[availableVariations.indexOf(activeVariation) + 1])}
                      className="absolute right-0 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>
                  )}
                </>
              ) : (
                /* No image — show color palette as visual placeholder */
                <div className="flex flex-col items-center gap-4 w-full">
                  {detail?.colorPalette && detail.colorPalette.length > 0 ? (
                    <div className="flex gap-3 justify-center flex-wrap">
                      {detail.colorPalette.map((c, i) => (
                        <div
                          key={i}
                          className="w-16 h-16 rounded-xl shadow-lg border border-white/10"
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="text-center">
                    <p className="text-white/30 text-sm">No image generated yet</p>
                    <p className="text-white/20 text-xs mt-1">Run a pipeline to generate images for this concept</p>
                  </div>
                </div>
              )}
            </div>

            {/* Export button */}
            {currentImage && (
              <Button
                onClick={() => handleExport(activeVariation)}
                disabled={exporting !== null}
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white w-full gap-2"
              >
                {exporting === activeVariation ? "Removing Background\u2026" : "\u2193 Download Production PNG"}
              </Button>
            )}

            {/* Next-step CTA buttons */}
            {currentImage && (
              <div className="flex gap-2 mt-2">
                <Link href={`/${slug}/mockups?conceptId=${conceptId}`} className="flex-1">
                  <Button size="sm" variant="outline" className="w-full gap-1.5 border-white/20 text-white hover:bg-white/10">
                    <Shirt className="h-3.5 w-3.5" /> Send to Mockups
                  </Button>
                </Link>
                <Link href={`/${slug}/design-studio?conceptId=${conceptId}`} className="flex-1">
                  <Button size="sm" variant="outline" className="w-full gap-1.5 border-white/20 text-white hover:bg-white/10">
                    <Paintbrush className="h-3.5 w-3.5" /> Design Studio
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {/* ── Right: Concept detail ── */}
          <div className="p-6 space-y-5 overflow-y-auto max-h-[92vh]">

            {/* Header */}
            <div className="space-y-1.5 pr-8">
              <div className="flex items-center gap-2 flex-wrap">
                {detail?.isWinner && (
                  <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded-full">
                    ★ #{detail.globalRank} Winner
                  </span>
                )}
                {detail?.format && <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{detail.format}</Badge>}
                {detail?.style && <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{detail.style}</Badge>}
                {detail?.humorFramework && <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">{detail.humorFramework}</Badge>}
              </div>
              <h2 className="text-xl font-bold text-white leading-tight">{conceptName}</h2>

              {/* Book link */}
              {detail?.bookTitle && (
                <p className="text-sm text-white/50">
                  From{" "}
                  {detail.bookId ? (
                    <Link
                      href={`/${slug}/book/${detail.bookId}`}
                      className="text-blue-400 hover:text-blue-300 underline underline-offset-2 font-medium"
                      onClick={(e) => { e.stopPropagation(); onClose(); }}
                    >
                      {detail.bookTitle}
                    </Link>
                  ) : (
                    <span className="text-white/70 font-medium">{detail.bookTitle}</span>
                  )}
                  {detail.bookAuthor && <span className="text-white/40"> by {detail.bookAuthor}</span>}
                </p>
              )}

              {/* Signal tags */}
              {detail?.signalTags && detail.signalTags.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-1">
                  {detail.signalTags.slice(0, 5).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-900/50 text-emerald-400 border border-emerald-700/50"
                      title="Cross-source signal: confirmed in multiple fan forums"
                    >
                      ⚡ {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Score + Signal Breakdown */}
            {detail?.trendScore != null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-white/50">
                  <span>Concept Score</span>
                  <span className="font-bold text-white">{detail.trendScore}/300</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
                    style={{ width: `${Math.min(100, (detail.trendScore / 300) * 100)}%` }}
                  />
                </div>

                {/* Signal Breakdown — actual scores */}
                {(detail.bookSocialMomentum != null || detail.bookDesignNovelty != null || detail.bookAudienceSize != null) && (
                  <div className="space-y-2 mt-3">
                    <p className="text-[10px] text-white/40 uppercase tracking-wide font-semibold">Signal Breakdown</p>
                    {detail.bookSocialMomentum != null && (
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-white/60">Social Momentum</span>
                          <span className="text-[11px] font-bold text-white">{detail.bookSocialMomentum}/100</span>
                        </div>
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-400 rounded-full" style={{ width: `${detail.bookSocialMomentum}%` }} />
                        </div>
                        {detail.bookSocialRationale && (
                          <p className="text-[10px] text-white/40 leading-snug">{detail.bookSocialRationale}</p>
                        )}
                      </div>
                    )}
                    {detail.bookDesignNovelty != null && (
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-white/60">Design Novelty</span>
                          <span className="text-[11px] font-bold text-white">{detail.bookDesignNovelty}/100</span>
                        </div>
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-purple-400 rounded-full" style={{ width: `${detail.bookDesignNovelty}%` }} />
                        </div>
                        {detail.bookDesignRationale && (
                          <p className="text-[10px] text-white/40 leading-snug">{detail.bookDesignRationale}</p>
                        )}
                      </div>
                    )}
                    {detail.bookAudienceSize != null && (
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-white/60">Audience Size</span>
                          <span className="text-[11px] font-bold text-white">{detail.bookAudienceSize}/100</span>
                        </div>
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-rose-400 rounded-full" style={{ width: `${detail.bookAudienceSize}%` }} />
                        </div>
                        {detail.bookAudienceRationale && (
                          <p className="text-[10px] text-white/40 leading-snug">{detail.bookAudienceRationale}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Why This Won — for winners */}
                {detail.isWinner && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mt-2">
                    <p className="text-[10px] text-amber-400/70 uppercase tracking-wide font-semibold mb-1">Why This Won</p>
                    <p className="text-xs text-white/70 leading-relaxed">
                      Ranked <span className="text-amber-400 font-bold">#{detail.globalRank}</span> globally
                      with a composite score of <span className="text-white font-bold">{detail.trendScore}/300</span>.
                      {detail.signalTags && detail.signalTags.length > 0
                        ? ` Anchored to ${detail.signalTags.length} cross-source signal${detail.signalTags.length > 1 ? "s" : ""}: ${detail.signalTags.slice(0, 3).join(", ")}${detail.signalTags.length > 3 ? "…" : ""}.`
                        : " Strong market potential based on niche research scoring."}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* The Idea */}
            <div className="space-y-3 border-t border-white/10 pt-4">
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">The Idea</h3>

              {detail?.sourcePhrase && (
                <div className="bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-amber-400/70 uppercase tracking-wide mb-1">Fan Phrase</p>
                  <p className="text-sm font-medium text-amber-200 leading-snug">"{detail.sourcePhrase}"</p>
                </div>
              )}

              {detail?.headline ? (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wide mb-0.5">Headline</p>
                  <p className="text-base font-semibold text-white leading-snug">"{detail.headline}"</p>
                </div>
              ) : (
                !detail && (
                  <div className="flex items-center gap-2 text-white/30 text-sm">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    Loading concept details…
                  </div>
                )
              )}

              {detail?.subtext && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wide mb-0.5">Subtext</p>
                  <p className="text-sm text-white/70 leading-relaxed">{detail.subtext}</p>
                </div>
              )}

              {detail?.layoutDescription && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wide mb-0.5">Layout</p>
                  <p className="text-sm text-white/60 leading-relaxed">{detail.layoutDescription}</p>
                </div>
              )}

              {detail?.fontSuggestion && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wide mb-0.5">Font</p>
                  <p className="text-sm text-white/60">{detail.fontSuggestion}</p>
                </div>
              )}
            </div>

            {/* Color Palette */}
            {detail?.colorPalette && detail.colorPalette.length > 0 && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Color Palette</h3>
                <div className="flex gap-2 flex-wrap">
                  {detail.colorPalette.map((c, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <div className="w-6 h-6 rounded-md border border-white/10 shadow" style={{ backgroundColor: c }} />
                      <span className="text-[10px] text-white/40 font-mono">{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Image Generation Prompt — always visible */}
            {currentPrompt && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
                  Image Prompt ({effectiveLabels[activeVariation]})
                </h3>
                <div className="bg-white/5 rounded-lg p-3 border border-white/10">
                  <p className="text-[11px] text-white/50 leading-relaxed font-mono whitespace-pre-wrap">{currentPrompt}</p>
                </div>
              </div>
            )}

            {/* Keyboard hint */}
            {hasAnyImage && (
              <p className="text-white/20 text-xs pt-2">← → to navigate variations · Esc to close</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
