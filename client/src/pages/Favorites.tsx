import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConceptCard } from "@/components/ConceptCard";
import { Heart } from "lucide-react";

export default function Favorites() {
  const [format, setFormat] = useState<string | undefined>(undefined);
  const [style, setStyle] = useState<string | undefined>(undefined);
  const [subgenre, setSubgenre] = useState<string | undefined>(undefined);
  const [humorFramework, setHumorFramework] = useState<string | undefined>(undefined);

  const filters = useMemo(
    () => ({
      format: format || undefined,
      style: style || undefined,
      subgenre: subgenre || undefined,
      humorFramework: humorFramework || undefined,
    }),
    [format, style, subgenre, humorFramework]
  );

  const { data: favorites, isLoading } = trpc.favorites.list.useQuery(filters);
  const { data: filterOptions } = trpc.favorites.getFilterOptions.useQuery();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const activeFilterCount = [format, style, subgenre, humorFramework].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Heart className="h-6 w-6 text-red-500" /> Favorites
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your saved design concepts
          {favorites && favorites.length > 0 && ` (${favorites.length} saved)`}
          {activeFilterCount > 0 && ` — ${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""} active`}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={format ?? "all"} onValueChange={(v) => setFormat(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Format" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Formats</SelectItem>
            {(filterOptions?.formats ?? []).map((f: string) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={style ?? "all"} onValueChange={(v) => setStyle(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Style" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Styles</SelectItem>
            {(filterOptions?.styles ?? []).map((s: string) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={subgenre ?? "all"} onValueChange={(v) => setSubgenre(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Subgenre" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Subgenres</SelectItem>
            {(filterOptions?.subgenres ?? []).map((sg: string) => (
              <SelectItem key={sg} value={sg}>{sg}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={humorFramework ?? "all"} onValueChange={(v) => setHumorFramework(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Humor Framework" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Frameworks</SelectItem>
            {(filterOptions?.humorFrameworks ?? []).map((hf: string) => (
              <SelectItem key={hf} value={hf}>{hf}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Concept Grid */}
      {!favorites || favorites.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Heart className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Favorites Yet</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Click the heart icon on any design concept to save it here.
              {activeFilterCount > 0 && " Try removing some filters."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {favorites.map((c: any) => (
            <ConceptCard
              key={c.id}
              id={c.id}
              conceptName={c.conceptName}
              format={c.format}
              style={c.style}
              headline={c.headline}
              subtext={c.subtext}
              colorPalette={c.colorPalette}
              layoutDescription={c.layoutDescription}
              fontSuggestion={c.fontSuggestion}
              copyrightSafe={c.copyrightSafe}
              isFavorite={c.isFavorite}
              bookId={c.bookId}
              bookTitle={c.bookTitle}
              bookAuthor={c.bookAuthor}
              humorFramework={c.humorFramework}
              trendScore={c.trendScore}
              trendRationale={c.trendRationale}
              imageUrlA={c.imageUrlA}
              imageUrlB={c.imageUrlB}
              imageUrlC={c.imageUrlC}
              imagePromptA={c.imagePromptA}
              imagePromptB={c.imagePromptB}
              imagePromptC={c.imagePromptC}
              isWinner={c.isWinner}
              globalRank={c.globalRank}
              showImages={true}
            />
          ))}
        </div>
      )}
    </div>
  );
}
