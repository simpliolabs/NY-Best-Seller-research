/**
 * SignalMap — Visual dashboard replacing the Research tab wall-of-text.
 * Shows: Radar chart (6 axes), Source health bar, 4 insight cards.
 */

import { RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Zap, BookOpen, Palette, Users, TrendingUp, Globe } from "lucide-react";

// ─── Types (mirrored from server/forumScraper.ts) ────────────────────────

interface RedditSignal { postCount: number; avgUpvotes: number; topSubreddits: string[]; sampleTitles: string[]; status: string }
interface GoodreadsSignal { ratingsCount: number; avgRating: number; reviewCount: number; topShelves: string[]; status: string }
interface StoryGraphSignal { moods: string[]; pace: string; themes: string[]; status: string }
interface FableSignal { clubCount: number; discussionCount: number; subjects?: string[]; status: string }
interface BookRiotSignal { articleCount: number; articleTitles: string[]; culturalAngles?: string[]; status: string }

interface ForumSignals {
  reddit?: RedditSignal;
  goodreads?: GoodreadsSignal;
  storyGraph?: StoryGraphSignal;
  fable?: FableSignal;
  bookRiot?: BookRiotSignal;
}

interface NicheResearch {
  fanConversations?: unknown;
  designStyles?: unknown;
  whiteSpace?: unknown;
}

interface Book {
  title: string;
  author: string;
  designNovelty?: number;
  socialMomentum?: number;
  audienceSize?: number;
  forumSignals?: string | null;
}

interface SignalMapProps {
  book: Book;
  forumSignals?: ForumSignals | null;
  nicheResearch?: NicheResearch | null;
  onGenerateConcept?: (opportunity: string) => void;
}

// ─── Normalization helpers (exported for tests) ──────────────────────────

export function normalizeRedditBuzz(postCount: number): number {
  return Math.min(100, Math.round((postCount / 50) * 100));
}

export function normalizeGoodreadsRating(avgRating: number): number {
  return Math.min(100, Math.round(avgRating * 20));
}

export function normalizeOpenLibraryReaders(themeCount: number): number {
  return Math.min(100, themeCount * 10);
}

export function extractFanLanguageTags(nicheResearch: NicheResearch | null | undefined, storyGraph: StoryGraphSignal | null | undefined): string[] {
  const tags: string[] = [];
  const fc = nicheResearch?.fanConversations;
  if (Array.isArray(fc)) tags.push(...fc.slice(0, 5).map(String));
  else if (typeof fc === "string" && fc.length > 0) {
    try { const parsed = JSON.parse(fc); if (Array.isArray(parsed)) tags.push(...parsed.slice(0, 5).map(String)); }
    catch { tags.push(...fc.split(",").slice(0, 5).map(s => s.trim()).filter(Boolean)); }
  }
  if (storyGraph?.themes) tags.push(...storyGraph.themes.slice(0, 5));
  return Array.from(new Set(tags)).slice(0, 8);
}

export function extractDesignAngles(nicheResearch: NicheResearch | null | undefined): string[] {
  const ds = nicheResearch?.designStyles;
  if (Array.isArray(ds)) return ds.slice(0, 3).map(String);
  if (typeof ds === "string" && ds.length > 0) {
    try { const parsed = JSON.parse(ds); if (Array.isArray(parsed)) return parsed.slice(0, 3).map(String); }
    catch { return ds.split(",").slice(0, 3).map(s => s.trim()).filter(Boolean); }
  }
  return [];
}

export function extractWhiteSpace(nicheResearch: NicheResearch | null | undefined): string[] {
  const ws = nicheResearch?.whiteSpace;
  if (Array.isArray(ws)) return ws.slice(0, 3).map(String);
  if (typeof ws === "string" && ws.length > 0) {
    try { const parsed = JSON.parse(ws); if (Array.isArray(parsed)) return parsed.slice(0, 3).map(String); }
    catch { return ws.split(",").slice(0, 3).map(s => s.trim()).filter(Boolean); }
  }
  return [];
}

// ─── Source Health Pill ──────────────────────────────────────────────────

function SourcePill({ label, status, detail }: { label: string; status: string; detail: string }) {
  const color =
    status === "success" ? "bg-green-100 text-green-700 border-green-200" :
    status === "failed"  ? "bg-red-100 text-red-600 border-red-200" :
    "bg-gray-100 text-gray-500 border-gray-200";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === "success" ? "bg-green-500" : status === "failed" ? "bg-red-400" : "bg-gray-400"}`} />
      {label}
      {detail && <span className="opacity-70">· {detail}</span>}
    </span>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

export function SignalMap({ book, forumSignals, nicheResearch, onGenerateConcept }: SignalMapProps) {
  // Parse forumSignals if stored as JSON string
  let signals: ForumSignals | null = forumSignals ?? null;
  if (!signals && book.forumSignals) {
    try { signals = JSON.parse(book.forumSignals as string); } catch { signals = null; }
  }

  // Radar data
  const radarData = [
    { axis: "Reddit Buzz",       value: normalizeRedditBuzz(signals?.reddit?.postCount ?? 0),                  fullMark: 100 },
    { axis: "GR Rating",         value: normalizeGoodreadsRating(signals?.goodreads?.avgRating ?? 0),          fullMark: 100 },
    { axis: "OL Readers",        value: normalizeOpenLibraryReaders(signals?.storyGraph?.themes?.length ?? 0), fullMark: 100 },
    { axis: "Design Novelty",    value: Math.min(100, Math.max(0, book.designNovelty ?? 0)),                   fullMark: 100 },
    { axis: "Social Momentum",   value: Math.min(100, Math.max(0, book.socialMomentum ?? 0)),                  fullMark: 100 },
    { axis: "Audience Size",     value: Math.min(100, Math.max(0, book.audienceSize ?? 0)),                    fullMark: 100 },
  ];

  // Insight card data
  const designAngles = extractDesignAngles(nicheResearch);
  const fanTags = extractFanLanguageTags(nicheResearch, signals?.storyGraph ?? null);
  const whiteSpace = extractWhiteSpace(nicheResearch);
  const culturalAngles = signals?.bookRiot?.culturalAngles ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Zap className="h-5 w-5 text-yellow-500" />
        <h2 className="text-lg font-semibold">Signal Map</h2>
        <span className="text-xs text-muted-foreground">Design potential at a glance</span>
      </div>

      {/* Radar Chart */}
      <Card className="border border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Design Potential Radar</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
              <PolarGrid stroke="hsl(var(--border))" />
              <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar
                name={book.title}
                dataKey="value"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.25}
                isAnimationActive={true}
              />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                formatter={(v: number) => [`${v}/100`, ""]}
              />
            </RadarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Source Health Bar */}
      <Card className="border border-border/50">
        <CardContent className="pt-4">
          <p className="text-xs font-medium text-muted-foreground mb-3">Data Sources</p>
          <div className="flex flex-wrap gap-2">
            <SourcePill label="Reddit" status={signals?.reddit?.status ?? "skipped"} detail={signals?.reddit?.postCount ? `${signals.reddit.postCount} posts` : ""} />
            <SourcePill label="Goodreads" status={signals?.goodreads?.status ?? "skipped"} detail={signals?.goodreads?.ratingsCount ? `${signals.goodreads.ratingsCount.toLocaleString()} ratings` : ""} />
            <SourcePill label="Open Library" status={signals?.storyGraph?.status ?? "skipped"} detail={signals?.storyGraph?.themes?.length ? `${signals.storyGraph.themes.length} themes` : ""} />
            <SourcePill label="Book Riot" status={signals?.bookRiot?.status ?? "skipped"} detail={signals?.bookRiot?.articleCount ? `${signals.bookRiot.articleCount} insights` : ""} />
            <SourcePill label="Fable" status={signals?.fable?.status ?? "skipped"} detail={signals?.fable?.clubCount ? `${signals.fable.clubCount} subjects` : ""} />
          </div>
        </CardContent>
      </Card>

      {/* 4 Insight Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Card 1 — Best Design Angles */}
        <Card className="border border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Palette className="h-4 w-4 text-purple-500" /> Best Design Angles
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {designAngles.length > 0 ? designAngles.map((angle, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-foreground truncate max-w-[80%]">{angle}</span>
                  <span className="text-muted-foreground">{100 - i * 20}%</span>
                </div>
                <Progress value={100 - i * 20} className="h-1.5" />
              </div>
            )) : (
              <p className="text-xs text-muted-foreground">Run a pipeline to generate design angles.</p>
            )}
          </CardContent>
        </Card>

        {/* Card 2 — Fan Language */}
        <Card className="border border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" /> Fan Language
            </CardTitle>
          </CardHeader>
          <CardContent>
            {fanTags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {fanTags.map((tag, i) => (
                  <Badge key={i} variant="secondary" className="text-xs capitalize">{tag}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No fan language data yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Card 3 — White Space Opportunities */}
        <Card className="border border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-green-500" /> White Space
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {whiteSpace.length > 0 ? whiteSpace.map((opp, i) => (
              <div key={i} className="flex items-start justify-between gap-2">
                <span className="text-xs text-foreground flex-1">{opp}</span>
                {onGenerateConcept && (
                  <Button size="sm" variant="outline" className="h-6 text-xs px-2 shrink-0" onClick={() => onGenerateConcept(opp)}>
                    Generate
                  </Button>
                )}
              </div>
            )) : (
              <p className="text-xs text-muted-foreground">No white space data yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Card 4 — Cross-Fandom */}
        <Card className="border border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-orange-500" /> Cross-Fandom
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {culturalAngles.length > 0 ? culturalAngles.map((angle, i) => (
              <div key={i} className="flex items-start gap-2">
                <TrendingUp className="h-3 w-3 text-orange-400 mt-0.5 shrink-0" />
                <span className="text-xs text-foreground">{angle}</span>
              </div>
            )) : signals?.bookRiot?.articleTitles?.length ? (
              signals.bookRiot.articleTitles.map((t, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Globe className="h-3 w-3 text-orange-400 mt-0.5 shrink-0" />
                  <span className="text-xs text-foreground">{t}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No cross-fandom data yet.</p>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
