import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ForumSource {
  status: "success" | "failed" | "skipped";
  [key: string]: any;
}

interface ForumSignals {
  reddit?: ForumSource & { postCount: number; avgUpvotes: number; topSubreddits: string[]; sampleTitles: string[] };
  goodreads?: ForumSource & { ratingsCount: number; avgRating: number; reviewCount: number; topShelves: string[] };
  storyGraph?: ForumSource & { moods: string[]; pace: string; themes: string[] };
  fable?: ForumSource & { clubCount: number; discussionCount: number };
  bookRiot?: ForumSource & { articleCount: number; articleTitles: string[] };
}

interface ForumSignalsBadgeProps {
  forumSignals: ForumSignals | null | undefined;
  compact?: boolean;
}

const SOURCE_CONFIG = [
  { key: "reddit" as const, label: "Reddit", icon: "💬" },
  { key: "goodreads" as const, label: "Goodreads", icon: "📚" },
  { key: "storyGraph" as const, label: "StoryGraph", icon: "📊" },
  { key: "fable" as const, label: "Fable", icon: "📖" },
  { key: "bookRiot" as const, label: "Book Riot", icon: "📰" },
];

function getStatusColor(status: string): string {
  switch (status) {
    case "success": return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "failed": return "bg-red-50 text-red-600 border-red-200";
    case "skipped": return "bg-gray-100 text-gray-500 border-gray-200";
    default: return "bg-gray-100 text-gray-500 border-gray-200";
  }
}

function getSourceSummary(key: string, source: ForumSource): string {
  if (source.status !== "success") return source.status;
  switch (key) {
    case "reddit": {
      const r = source as ForumSignals["reddit"] & {};
      return `${r.postCount} posts, avg ${r.avgUpvotes} upvotes`;
    }
    case "goodreads": {
      const g = source as ForumSignals["goodreads"] & {};
      return `${g.ratingsCount?.toLocaleString()} ratings (${g.avgRating}★)`;
    }
    case "storyGraph": {
      const s = source as ForumSignals["storyGraph"] & {};
      return s.moods?.length ? `Moods: ${s.moods.join(", ")}` : "Data found";
    }
    case "fable": {
      const f = source as ForumSignals["fable"] & {};
      return `${f.clubCount} clubs, ${f.discussionCount} discussions`;
    }
    case "bookRiot": {
      const b = source as ForumSignals["bookRiot"] & {};
      return `${b.articleCount} articles`;
    }
    default: return "Data found";
  }
}

export function ForumSignalsBadge({ forumSignals, compact = false }: ForumSignalsBadgeProps) {
  if (!forumSignals) return null;

  const sources = SOURCE_CONFIG.map(({ key, label, icon }) => {
    const source = forumSignals[key];
    return { key, label, icon, source };
  }).filter(s => s.source);

  if (sources.length === 0) return null;

  const successCount = sources.filter(s => s.source?.status === "success").length;

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-xs gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200">
              📡 {successCount}/{sources.length} sources
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-1">
              <p className="font-semibold text-sm">Forum Data Sources</p>
              {sources.map(({ key, label, icon, source }) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span>{icon}</span>
                  <span className="font-medium">{label}:</span>
                  <span className={source?.status === "success" ? "text-emerald-600" : "text-gray-400"}>
                    {source ? getSourceSummary(key, source) : "N/A"}
                  </span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-gray-700">Forum Data Sources</h4>
        <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
          {successCount}/{sources.length} live
        </Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {sources.map(({ key, label, icon, source }) => (
          <div
            key={key}
            className={`flex items-start gap-2 p-2.5 rounded-lg border ${getStatusColor(source?.status ?? "skipped")}`}
          >
            <span className="text-base mt-0.5">{icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold">{label}</span>
                {source?.status === "success" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                )}
                {source?.status === "failed" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                )}
              </div>
              <p className="text-xs mt-0.5 opacity-80 truncate">
                {source ? getSourceSummary(key, source) : "Not scraped"}
              </p>
              {/* Extra detail for successful sources */}
              {key === "reddit" && source?.status === "success" && (source as any).topSubreddits?.length > 0 && (
                <p className="text-[10px] mt-0.5 opacity-60 truncate">
                  {(source as any).topSubreddits.join(", ")}
                </p>
              )}
              {key === "goodreads" && source?.status === "success" && (source as any).topShelves?.length > 0 && (
                <p className="text-[10px] mt-0.5 opacity-60 truncate">
                  {(source as any).topShelves.slice(0, 4).join(", ")}
                </p>
              )}
              {key === "storyGraph" && source?.status === "success" && (source as any).pace && (
                <p className="text-[10px] mt-0.5 opacity-60">
                  Pace: {(source as any).pace}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ForumSignalsDetail({ forumSignals }: { forumSignals: ForumSignals | null | undefined }) {
  if (!forumSignals) return null;

  return (
    <div className="space-y-4">
      {/* Reddit Detail */}
      {forumSignals.reddit?.status === "success" && forumSignals.reddit.sampleTitles.length > 0 && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Reddit Mentions</h5>
          <ul className="space-y-1">
            {forumSignals.reddit.sampleTitles.map((title, i) => (
              <li key={i} className="text-xs text-gray-600 pl-3 border-l-2 border-blue-200">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Goodreads Detail */}
      {forumSignals.goodreads?.status === "success" && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Goodreads</h5>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
              {forumSignals.goodreads.avgRating}★ avg
            </Badge>
            <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
              {forumSignals.goodreads.ratingsCount.toLocaleString()} ratings
            </Badge>
            {forumSignals.goodreads.reviewCount > 0 && (
              <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                {forumSignals.goodreads.reviewCount.toLocaleString()} reviews
              </Badge>
            )}
          </div>
          {forumSignals.goodreads.topShelves.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {forumSignals.goodreads.topShelves.map((shelf, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                  {shelf}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* StoryGraph Detail */}
      {forumSignals.storyGraph?.status === "success" && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">StoryGraph</h5>
          <div className="flex flex-wrap gap-1.5">
            {forumSignals.storyGraph.moods.map((mood, i) => (
              <Badge key={i} variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                {mood}
              </Badge>
            ))}
            {forumSignals.storyGraph.pace && (
              <Badge variant="outline" className="text-xs bg-indigo-50 text-indigo-700 border-indigo-200">
                {forumSignals.storyGraph.pace} pace
              </Badge>
            )}
          </div>
          {forumSignals.storyGraph.themes.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {forumSignals.storyGraph.themes.map((theme, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                  {theme}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Book Riot Detail */}
      {forumSignals.bookRiot?.status === "success" && forumSignals.bookRiot.articleTitles.length > 0 && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Book Riot Articles</h5>
          <ul className="space-y-1">
            {forumSignals.bookRiot.articleTitles.map((title, i) => (
              <li key={i} className="text-xs text-gray-600 pl-3 border-l-2 border-orange-200">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Fable Detail */}
      {forumSignals.fable?.status === "success" && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Fable</h5>
          <div className="flex gap-2">
            <Badge variant="outline" className="text-xs bg-teal-50 text-teal-700 border-teal-200">
              {forumSignals.fable.clubCount} book clubs
            </Badge>
            <Badge variant="outline" className="text-xs bg-teal-50 text-teal-700 border-teal-200">
              {forumSignals.fable.discussionCount} discussions
            </Badge>
          </div>
        </div>
      )}
    </div>
  );
}
