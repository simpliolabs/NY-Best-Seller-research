/**
 * SignalVenn — Shows which design themes/ideas have signal across multiple sources.
 * The more sources a theme appears in, the stronger the signal.
 * Overlap zones = the gold: ideas confirmed by multiple independent communities.
 */

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, TrendingUp, Circle } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────

interface ForumSignals {
  reddit?: { postCount: number; avgUpvotes: number; topSubreddits: string[]; sampleTitles: string[]; status: string };
  goodreads?: { ratingsCount: number; avgRating: number; reviewCount: number; topShelves: string[]; status: string };
  storyGraph?: { moods: string[]; pace: string; themes: string[]; status: string };
  fable?: { clubCount: number; discussionCount: number; subjects?: string[]; status: string };
  bookRiot?: { articleCount: number; articleTitles: string[]; culturalAngles?: string[]; status: string };
}

interface NicheResearch {
  fanConversations?: unknown;
  designStyles?: unknown;
  whiteSpace?: unknown;
}

interface SignalVennProps {
  forumSignals?: ForumSignals | null;
  nicheResearch?: NicheResearch | null;
  bookTitle?: string;
}

// ─── Source definitions ───────────────────────────────────────────────────

const SOURCES = [
  { key: "reddit",     label: "Reddit",      color: "#FF6314", lightColor: "#FFF0E8", textColor: "#C44A00" },
  { key: "goodreads",  label: "Goodreads",   color: "#F4C430", lightColor: "#FFFBE8", textColor: "#8B6914" },
  { key: "storyGraph", label: "Open Library",color: "#4A90D9", lightColor: "#EBF4FF", textColor: "#1A5FA8" },
  { key: "fable",      label: "Fable/OL",    color: "#50C878", lightColor: "#EDFAF2", textColor: "#1A7A3C" },
  { key: "bookRiot",   label: "Book Riot",   color: "#9B59B6", lightColor: "#F5EEFF", textColor: "#6A1B9A" },
] as const;

type SourceKey = typeof SOURCES[number]["key"];

// ─── Theme extraction ─────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set(["with", "that", "this", "from", "have", "been", "will", "they", "their", "about", "into", "more", "some", "also", "when", "what", "which", "your", "book", "books", "read", "reading", "story", "novel", "fiction", "nonfiction"]);

function extractSourceThemes(signals: ForumSignals | null | undefined, nicheResearch: NicheResearch | null | undefined): Record<SourceKey, Set<string>> {
  const result: Record<SourceKey, Set<string>> = {
    reddit: new Set(),
    goodreads: new Set(),
    storyGraph: new Set(),
    fable: new Set(),
    bookRiot: new Set(),
  };

  // Reddit: subreddits + title keywords
  if (signals?.reddit?.status === "success") {
    signals.reddit.topSubreddits.forEach(sub => {
      const clean = sub.replace(/^r\//, "").toLowerCase();
      if (clean.length > 2) result.reddit.add(clean);
    });
    signals.reddit.sampleTitles.forEach(title => {
      tokenize(title).forEach(t => result.reddit.add(t));
    });
  }

  // Goodreads: shelves
  if (signals?.goodreads?.status === "success") {
    signals.goodreads.topShelves.forEach(shelf => {
      normalize(shelf).split(/[\s-]+/).forEach(w => {
        if (w.length > 3 && !STOPWORDS.has(w)) result.goodreads.add(w);
      });
    });
  }

  // Open Library (StoryGraph): moods + themes
  if (signals?.storyGraph?.status === "success") {
    signals.storyGraph.moods.forEach(m => result.storyGraph.add(normalize(m)));
    signals.storyGraph.themes.forEach(t => {
      tokenize(t).forEach(w => result.storyGraph.add(w));
    });
    if (signals.storyGraph.pace) result.storyGraph.add(normalize(signals.storyGraph.pace));
  }

  // Fable/OL Work: subjects
  if (signals?.fable?.status === "success") {
    (signals.fable.subjects ?? []).forEach(s => {
      tokenize(s).forEach(w => result.fable.add(w));
    });
  }

  // Book Riot: article titles + cultural angles
  if (signals?.bookRiot?.status === "success") {
    signals.bookRiot.articleTitles.forEach(t => {
      tokenize(t).forEach(w => result.bookRiot.add(w));
    });
    (signals.bookRiot.culturalAngles ?? []).forEach(a => {
      tokenize(a).forEach(w => result.bookRiot.add(w));
    });
  }

  // Niche research: fan conversations + design styles + white space
  const parseField = (f: unknown): string[] => {
    if (!f) return [];
    if (Array.isArray(f)) return f.map(String);
    if (typeof f === "string") {
      try { const p = JSON.parse(f); return Array.isArray(p) ? p.map(String) : [f]; }
      catch { return f.split(",").map(s => s.trim()).filter(Boolean); }
    }
    return [];
  };
  parseField(nicheResearch?.fanConversations).forEach(s => tokenize(s).forEach(w => result.reddit.add(w)));
  parseField(nicheResearch?.designStyles).forEach(s => tokenize(s).forEach(w => result.goodreads.add(w)));
  parseField(nicheResearch?.whiteSpace).forEach(s => tokenize(s).forEach(w => result.fable.add(w)));

  return result;
}

// ─── Overlap computation ──────────────────────────────────────────────────

interface ThemeSignal {
  theme: string;
  sources: SourceKey[];
  strength: number; // 1–5
}

function computeOverlaps(sourceThemes: Record<SourceKey, Set<string>>): ThemeSignal[] {
  const allThemes = new Map<string, Set<SourceKey>>();
  (Object.keys(sourceThemes) as SourceKey[]).forEach(src => {
    sourceThemes[src].forEach(theme => {
      if (!allThemes.has(theme)) allThemes.set(theme, new Set());
      allThemes.get(theme)!.add(src);
    });
  });

  return Array.from(allThemes.entries())
    .filter(([, srcs]) => srcs.size >= 1)
    .map(([theme, srcs]) => ({
      theme,
      sources: Array.from(srcs),
      strength: srcs.size,
    }))
    .sort((a, b) => b.strength - a.strength || a.theme.localeCompare(b.theme))
    .slice(0, 60);
}

// ─── SVG Venn Layout ──────────────────────────────────────────────────────
// 5-circle layout: pentagon arrangement

const CIRCLE_POSITIONS = [
  { cx: 200, cy: 100, key: "reddit"     as SourceKey },
  { cx: 320, cy: 180, key: "goodreads"  as SourceKey },
  { cx: 280, cy: 310, key: "storyGraph" as SourceKey },
  { cx: 120, cy: 310, key: "fable"      as SourceKey },
  { cx: 80,  cy: 180, key: "bookRiot"   as SourceKey },
];
const R = 110; // circle radius

// ─── Main Component ───────────────────────────────────────────────────────

export function SignalVenn({ forumSignals, nicheResearch, bookTitle }: SignalVennProps) {
  const sourceThemes = useMemo(() => extractSourceThemes(forumSignals, nicheResearch), [forumSignals, nicheResearch]);
  const overlaps = useMemo(() => computeOverlaps(sourceThemes), [sourceThemes]);

  const multiSource = overlaps.filter(o => o.strength >= 2);
  const singleSource = overlaps.filter(o => o.strength === 1);
  const topOverlaps = multiSource.slice(0, 20);

  // Active sources (have data)
  const activeSources = SOURCES.filter(s => {
    const sig = forumSignals?.[s.key as SourceKey] as { status?: string } | undefined;
    return sig?.status === "success";
  });

  const totalThemes = overlaps.length;
  const crossSourceCount = multiSource.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-yellow-500" />
          <h2 className="text-lg font-semibold">Signal Venn</h2>
          <span className="text-xs text-muted-foreground">Ideas confirmed across multiple sources = strongest design signal</span>
        </div>
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{crossSourceCount}</span> cross-source ·
          <span className="font-medium text-foreground">{totalThemes}</span> total themes
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* SVG Venn Diagram */}
        <Card className="border border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Source Overlap Map</CardTitle>
          </CardHeader>
          <CardContent>
            <svg viewBox="0 0 400 420" className="w-full max-h-80">
              <defs>
                {SOURCES.map(s => (
                  <radialGradient key={s.key} id={`grad-${s.key}`} cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={s.color} stopOpacity="0.25" />
                    <stop offset="100%" stopColor={s.color} stopOpacity="0.08" />
                  </radialGradient>
                ))}
              </defs>

              {/* Circles */}
              {CIRCLE_POSITIONS.map(pos => {
                const src = SOURCES.find(s => s.key === pos.key)!;
                const isActive = activeSources.some(a => a.key === pos.key);
                const themeCount = sourceThemes[pos.key].size;
                return (
                  <g key={pos.key}>
                    <circle
                      cx={pos.cx} cy={pos.cy} r={R}
                      fill={isActive ? `url(#grad-${pos.key})` : "transparent"}
                      stroke={src.color}
                      strokeWidth={isActive ? 2 : 1}
                      strokeDasharray={isActive ? "none" : "4 3"}
                      opacity={isActive ? 1 : 0.35}
                    />
                    {/* Label */}
                    <text
                      x={pos.cx}
                      y={pos.cy - R - 8}
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="600"
                      fill={isActive ? src.textColor : "#9CA3AF"}
                    >
                      {src.label}
                    </text>
                    {isActive && themeCount > 0 && (
                      <text
                        x={pos.cx}
                        y={pos.cy - R + 4}
                        textAnchor="middle"
                        fontSize="8"
                        fill={src.textColor}
                        opacity="0.7"
                      >
                        {themeCount} themes
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Overlap strength dots — place top cross-source themes as dots at centroid of their sources */}
              {topOverlaps.slice(0, 15).map((item, i) => {
                const positions = item.sources
                  .map(sk => CIRCLE_POSITIONS.find(p => p.key === sk))
                  .filter(Boolean) as typeof CIRCLE_POSITIONS[number][];
                if (positions.length === 0) return null;
                const cx = positions.reduce((s, p) => s + p.cx, 0) / positions.length;
                const cy = positions.reduce((s, p) => s + p.cy, 0) / positions.length;
                const r = Math.max(4, item.strength * 3);
                const color = item.strength >= 4 ? "#EF4444" : item.strength === 3 ? "#F59E0B" : item.strength === 2 ? "#3B82F6" : "#9CA3AF";
                return (
                  <g key={`dot-${i}`}>
                    <circle cx={cx} cy={cy} r={r + 2} fill={color} opacity="0.15" />
                    <circle cx={cx} cy={cy} r={r} fill={color} opacity="0.7" />
                    {item.strength >= 3 && (
                      <text x={cx} y={cy + r + 9} textAnchor="middle" fontSize="7" fill={color} fontWeight="600">
                        {item.theme.length > 10 ? item.theme.slice(0, 10) + "…" : item.theme}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Legend */}
              <g transform="translate(10, 380)">
                {[
                  { color: "#EF4444", label: "4–5 sources" },
                  { color: "#F59E0B", label: "3 sources" },
                  { color: "#3B82F6", label: "2 sources" },
                  { color: "#9CA3AF", label: "1 source" },
                ].map((l, i) => (
                  <g key={i} transform={`translate(${i * 90}, 0)`}>
                    <circle cx="6" cy="6" r="5" fill={l.color} opacity="0.7" />
                    <text x="14" y="10" fontSize="8" fill="#6B7280">{l.label}</text>
                  </g>
                ))}
              </g>
            </svg>
          </CardContent>
        </Card>

        {/* Ranked Signal List */}
        <div className="space-y-3">
          {/* Strongest signals (2+ sources) */}
          <Card className="border border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-500" />
                Strongest Signals
                <Badge variant="secondary" className="text-xs ml-auto">{multiSource.length} themes</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {multiSource.length === 0 ? (
                <p className="text-xs text-muted-foreground">Run a pipeline to generate cross-source signals. Books need forum data scraped first.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {multiSource.slice(0, 25).map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {/* Strength bar */}
                      <div className="flex gap-0.5 shrink-0">
                        {[1,2,3,4,5].map(n => (
                          <div
                            key={n}
                            className={`w-1.5 h-4 rounded-sm ${n <= item.strength
                              ? item.strength >= 4 ? "bg-red-500"
                              : item.strength === 3 ? "bg-amber-500"
                              : "bg-blue-500"
                              : "bg-muted"}`}
                          />
                        ))}
                      </div>
                      {/* Theme name */}
                      <span className="text-xs font-medium text-foreground capitalize flex-1 truncate">{item.theme}</span>
                      {/* Source badges */}
                      <div className="flex gap-0.5 shrink-0">
                        {item.sources.map(sk => {
                          const src = SOURCES.find(s => s.key === sk)!;
                          return (
                            <span
                              key={sk}
                              className="text-[9px] px-1 py-0.5 rounded font-medium"
                              style={{ background: src.lightColor, color: src.textColor }}
                            >
                              {src.label.split(" ")[0].slice(0, 4)}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Source breakdown */}
          <Card className="border border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Circle className="h-4 w-4 text-muted-foreground" />
                Per-Source Themes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {SOURCES.map(src => {
                  const themes = Array.from(sourceThemes[src.key]).slice(0, 8);
                  const isActive = activeSources.some(a => a.key === src.key);
                  return (
                    <div key={src.key} className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: isActive ? src.color : "#D1D5DB" }}
                        />
                        <span className={`text-xs font-semibold ${isActive ? "" : "text-muted-foreground"}`}>
                          {src.label}
                        </span>
                        {!isActive && <span className="text-[10px] text-muted-foreground">(no data)</span>}
                      </div>
                      {isActive && themes.length > 0 && (
                        <div className="flex flex-wrap gap-1 pl-3.5">
                          {themes.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] px-1.5 py-0.5 rounded capitalize"
                              style={{ background: src.lightColor, color: src.textColor }}
                            >
                              {t}
                            </span>
                          ))}
                          {sourceThemes[src.key].size > 8 && (
                            <span className="text-[10px] text-muted-foreground">+{sourceThemes[src.key].size - 8} more</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* No data state */}
      {activeSources.length === 0 && (
        <Card className="border border-dashed border-border/50">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No forum data scraped yet for this book.</p>
            <p className="text-xs text-muted-foreground mt-1">Run a new pipeline — the v5 scrapers will pull live data from Reddit, Goodreads, Open Library, and Book Riot.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
