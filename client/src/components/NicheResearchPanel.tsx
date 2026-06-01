import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, MessageCircle, Palette, Lightbulb } from "lucide-react";
import { useState, useMemo } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface FanConversations {
  // camelCase (DB schema)
  insideJokes?: string[];
  slogans?: string[];
  communityReferences?: string[];
  painPoints?: string[];
  identityMarkers?: string[];
  // snake_case (legacy LLM output)
  inside_jokes?: string[];
  slogans_catchphrases?: string[];
  community_references?: string[];
  pain_points_they_joke_about?: string[];
  identity_markers?: string[];
}

interface DesignStyles {
  // camelCase (DB schema)
  colorPalettes?: string[];
  typographyPreferences?: string[];
  artStyles?: string[];
  formatPreferences?: string[];
  aestheticMovements?: string[];
  // snake_case (legacy LLM output)
  color_palettes?: string[];
  typography_preferences?: string[];
  art_styles?: string[];
  format_preferences?: string[];
  aesthetic_movements?: string[];
}

interface WhiteSpace {
  // camelCase (DB schema)
  untappedHumorAngles?: string[];
  ignoredSubAudiences?: string[];
  missingFormats?: string[];
  crossFandomOpportunities?: string[];
  oversaturated?: string[];
  fresh?: string[];
  // snake_case (legacy LLM output)
  untapped_humor_angles?: string[];
  ignored_sub_audiences?: string[];
  missing_formats?: string[];
  cross_fandom_opportunities?: string[];
  oversaturated_vs_fresh?: string[];
}

interface ForumSignals {
  reddit?: { sampleTitles?: string[]; topSubreddits?: string[]; status?: string };
  goodreads?: { topShelves?: string[]; status?: string };
  storyGraph?: { moods?: string[]; themes?: string[]; status?: string };
  fable?: { status?: string; subjects?: string[] };
  bookRiot?: { articleTitles?: string[]; culturalAngles?: string[]; status?: string };
}

interface NicheResearchPanelProps {
  fanConversations: FanConversations | null;
  designStyles: DesignStyles | null;
  whiteSpace: WhiteSpace | null;
  bookTitle?: string;
  forumSignals?: ForumSignals | null;
}

// ── Cross-source signal engine ─────────────────────────────────────────────

/** Tokenise a phrase into lowercase keywords (3+ chars, no stop words) */
const STOP = new Set(["the","and","for","with","that","this","from","are","was","were","has","have","not","but","its","can","will","they","their","about","also","into","more","some","than","then","when","where","which","who","how","what","been","being","very","just","even","only","like","over","such","your","our","all","any","each","both","few","most","other","same","own","off","out","up","down","in","on","at","to","of","a","an","is","it","by","as","or","if","so","do","no","be","we","he","she","his","her","him","us","me","my","you","i"]);
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
}

/** Collect all tokens from forum signals across 5 sources */
function buildForumTokens(fs: ForumSignals | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (words: string[]) => words.forEach(w => counts.set(w, (counts.get(w) ?? 0) + 1));

  if (!fs) return counts;

  // Reddit: sample titles + subreddits
  if (fs.reddit?.status === "success") {
    (fs.reddit.sampleTitles ?? []).forEach(t => bump(tokenize(t)));
    (fs.reddit.topSubreddits ?? []).forEach(t => bump(tokenize(t)));
  }
  // Goodreads: shelves
  if (fs.goodreads?.status === "success") {
    (fs.goodreads.topShelves ?? []).forEach(t => bump(tokenize(t)));
  }
  // StoryGraph: moods + themes
  if (fs.storyGraph?.status === "success") {
    (fs.storyGraph.moods ?? []).forEach(t => bump(tokenize(t)));
    (fs.storyGraph.themes ?? []).forEach(t => bump(tokenize(t)));
  }
  // Fable: subjects
  if (fs.fable?.status === "success") {
    ((fs.fable as any).subjects ?? []).forEach((t: string) => bump(tokenize(t)));
  }
  // Book Riot: article titles + cultural angles
  if (fs.bookRiot?.status === "success") {
    (fs.bookRiot.articleTitles ?? []).forEach(t => bump(tokenize(t)));
    (fs.bookRiot.culturalAngles ?? []).forEach(t => bump(tokenize(t)));
  }

  return counts;
}

/** Score a niche-research phrase against the forum token map */
function scorePhrase(phrase: string, tokenMap: Map<string, number>): number {
  const words = tokenize(phrase);
  if (words.length === 0) return 0;
  return words.reduce((sum, w) => sum + (tokenMap.get(w) ?? 0), 0);
}

/** Return source-count label colour */
function signalColor(score: number): string {
  if (score >= 4) return "bg-red-500 text-white";
  if (score >= 2) return "bg-amber-500 text-white";
  if (score >= 1) return "bg-blue-500 text-white";
  return "";
}

// ── Sub-components ─────────────────────────────────────────────────────────

const PILL_LIMIT = 5;

function ResearchSection({
  icon: Icon,
  title,
  color,
  children,
  defaultOpen = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  color: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center justify-between w-full p-3 rounded-lg bg-secondary/50 hover:bg-secondary/80 transition-colors group">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-md ${color}`}>
            <Icon className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-medium text-foreground">{title}</span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 px-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TagList({
  label,
  items,
  tokenMap,
}: {
  label: string;
  items?: string[];
  tokenMap: Map<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!items || items.length === 0) return null;

  // Sort by signal score descending so strongest signals appear first
  const scored = useMemo(
    () => items.map(item => ({ item, score: scorePhrase(item, tokenMap) })).sort((a, b) => b.score - a.score),
    [items, tokenMap]
  );

  const visibleItems = expanded ? scored : scored.slice(0, PILL_LIMIT);
  const hiddenCount = scored.length - PILL_LIMIT;
  const hasMore = scored.length > PILL_LIMIT;

  return (
    <div className="mb-3">
      <p className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5 items-center">
        {visibleItems.map(({ item, score }, i) => (
          <div key={i} className="flex items-center gap-1">
            <Badge
              variant="outline"
              className={`text-xs font-normal leading-relaxed py-1 px-2 max-w-full ${score >= 2 ? "border-amber-400/60" : ""}`}
            >
              <span className="line-clamp-2">{item}</span>
            </Badge>
            {score >= 1 && (
              <span
                className={`inline-flex items-center justify-center rounded-full text-[9px] font-bold px-1.5 py-0.5 leading-none ${signalColor(score)}`}
                title={`Mentioned across ${score} forum source${score !== 1 ? "s" : ""}`}
              >
                {score}×
              </span>
            )}
          </div>
        ))}
        {hasMore && !expanded && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-primary hover:text-primary/80"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount} more
          </Button>
        )}
        {hasMore && expanded && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(false)}
          >
            Show less
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export function NicheResearchPanel({
  fanConversations,
  designStyles,
  whiteSpace,
  bookTitle,
  forumSignals,
}: NicheResearchPanelProps) {
  const hasData = fanConversations || designStyles || whiteSpace;

  // Build cross-source token map once
  const tokenMap = useMemo(() => buildForumTokens(forumSignals), [forumSignals]);
  const hasForumSignals = forumSignals && Object.values(forumSignals).some((s: any) => s?.status === "success");

  if (!hasData) {
    return (
      <Card className="bg-card border-border/50">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No niche research data available yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2 flex-wrap">
          <Lightbulb className="h-4 w-4 text-primary" />
          Niche Research
          {bookTitle && (
            <span className="text-xs text-muted-foreground font-normal">— {bookTitle}</span>
          )}
          {hasForumSignals && (
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground font-normal">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> 4+ sources
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 ml-1" /> 2–3 sources
              <span className="inline-block w-2 h-2 rounded-full bg-blue-500 ml-1" /> 1 source
              <span className="text-muted-foreground/50 ml-1">= cross-source signal</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Design Styles — most actionable */}
        {designStyles && (
          <ResearchSection
            icon={Palette}
            title="Design Styles That Resonate"
            color="bg-emerald-600"
            defaultOpen={true}
          >
            <TagList label="Color Palettes" items={designStyles.colorPalettes ?? designStyles.color_palettes} tokenMap={tokenMap} />
            <TagList label="Typography" items={designStyles.typographyPreferences ?? designStyles.typography_preferences} tokenMap={tokenMap} />
            <TagList label="Art Styles" items={designStyles.artStyles ?? designStyles.art_styles} tokenMap={tokenMap} />
            <TagList label="Format Preferences" items={designStyles.formatPreferences ?? designStyles.format_preferences} tokenMap={tokenMap} />
            <TagList label="Aesthetic Movements" items={designStyles.aestheticMovements ?? designStyles.aesthetic_movements} tokenMap={tokenMap} />
          </ResearchSection>
        )}

        {/* White Space — differentiation opportunities */}
        {whiteSpace && (
          <ResearchSection
            icon={Lightbulb}
            title="White Space Opportunities"
            color="bg-amber-600"
            defaultOpen={true}
          >
            <TagList label="Untapped Humor Angles" items={whiteSpace.untappedHumorAngles ?? whiteSpace.untapped_humor_angles} tokenMap={tokenMap} />
            <TagList label="Ignored Sub-Audiences" items={whiteSpace.ignoredSubAudiences ?? whiteSpace.ignored_sub_audiences} tokenMap={tokenMap} />
            <TagList label="Missing Formats" items={whiteSpace.missingFormats ?? whiteSpace.missing_formats} tokenMap={tokenMap} />
            <TagList label="Cross-Fandom Opportunities" items={whiteSpace.crossFandomOpportunities ?? whiteSpace.cross_fandom_opportunities} tokenMap={tokenMap} />
            <TagList label="Oversaturated vs Fresh" items={[...(whiteSpace.oversaturated ?? []), ...(whiteSpace.fresh ?? []), ...(whiteSpace.oversaturated_vs_fresh ?? [])]} tokenMap={tokenMap} />
          </ResearchSection>
        )}

        {/* Fan Conversations — supporting evidence */}
        {fanConversations && (
          <ResearchSection
            icon={MessageCircle}
            title="Fan Conversations"
            color="bg-violet-600"
            defaultOpen={false}
          >
            <TagList label="Inside Jokes" items={fanConversations.insideJokes ?? fanConversations.inside_jokes} tokenMap={tokenMap} />
            <TagList label="Slogans & Catchphrases" items={fanConversations.slogans ?? fanConversations.slogans_catchphrases} tokenMap={tokenMap} />
            <TagList label="Community References" items={fanConversations.communityReferences ?? fanConversations.community_references} tokenMap={tokenMap} />
            <TagList label="Pain Points They Joke About" items={fanConversations.painPoints ?? fanConversations.pain_points_they_joke_about} tokenMap={tokenMap} />
            <TagList label="Identity Markers" items={fanConversations.identityMarkers ?? fanConversations.identity_markers} tokenMap={tokenMap} />
          </ResearchSection>
        )}
      </CardContent>
    </Card>
  );
}
