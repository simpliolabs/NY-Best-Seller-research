import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ShoppingBag, Palette, TrendingUp, ImageOff } from "lucide-react";

interface DesignImageGalleryProps {
  imageUrlA: string | null;
  imageUrlB: string | null;
  imageUrlC?: string | null;
  imagePromptA: string | null;
  imagePromptB: string | null;
  imagePromptC?: string | null;
  conceptName: string;
}

// Also export with old name for backwards compatibility
export type DesignImagePairProps = DesignImageGalleryProps;

const VARIATIONS = [
  {
    key: "A" as const,
    label: "Clean / Commercial",
    sublabel: "Etsy bestseller",
    icon: ShoppingBag,
    accentColor: "text-emerald-600",
    bgAccent: "bg-emerald-50 border-emerald-200",
  },
  {
    key: "B" as const,
    label: "Bold / Artistic",
    sublabel: "Design blog feature",
    icon: Palette,
    accentColor: "text-violet-600",
    bgAccent: "bg-violet-50 border-violet-200",
  },
  {
    key: "C" as const,
    label: "Trending / Social",
    sublabel: "TikTok & Instagram",
    icon: TrendingUp,
    accentColor: "text-amber-600",
    bgAccent: "bg-amber-50 border-amber-200",
  },
];

function DesignImage({
  url,
  prompt,
  label,
  sublabel,
  icon: Icon,
  accentColor,
  bgAccent,
}: {
  url: string | null;
  prompt: string | null;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ className?: string }>;
  accentColor: string;
  bgAccent: string;
}) {
  if (!url) {
    return (
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-1.5 mb-2 px-2 py-1 rounded-md border ${bgAccent}`}>
          <Icon className={`h-3.5 w-3.5 ${accentColor}`} />
          <div>
            <span className="text-xs font-semibold text-foreground">{label}</span>
            <span className="text-[10px] text-muted-foreground ml-1">· {sublabel}</span>
          </div>
        </div>
        <div className="aspect-square rounded-lg bg-muted/30 border border-border flex flex-col items-center justify-center gap-2">
          <ImageOff className="h-8 w-8 text-muted-foreground/30" />
          <span className="text-xs text-muted-foreground/50">Not generated</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0">
      <div className={`flex items-center gap-1.5 mb-2 px-2 py-1 rounded-md border ${bgAccent}`}>
        <Icon className={`h-3.5 w-3.5 ${accentColor}`} />
        <div>
          <span className="text-xs font-semibold text-foreground">{label}</span>
          <span className="text-[10px] text-muted-foreground ml-1">· {sublabel}</span>
        </div>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button className="w-full group relative rounded-lg overflow-hidden border border-border hover:border-primary/50 transition-colors cursor-zoom-in shadow-sm hover:shadow-md">
            <img
              src={url}
              alt={`${label} design`}
              className="w-full aspect-square object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <div className="absolute bottom-2 left-2 right-2">
                <Badge variant="secondary" className="text-[10px] bg-white/90 text-foreground">
                  Click to enlarge
                </Badge>
              </div>
            </div>
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-3xl p-2 bg-card">
          <img
            src={url}
            alt={`${label} design — full size`}
            className="w-full rounded-lg"
          />
          {prompt && (
            <div className="p-3 bg-muted/50 rounded-lg mt-2 border border-border">
              <p className="text-xs text-muted-foreground mb-1 font-semibold uppercase tracking-wider">
                {label} — Generation Prompt
              </p>
              <p className="text-xs text-foreground/80 leading-relaxed">{prompt}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DesignImagePair({
  imageUrlA,
  imageUrlB,
  imageUrlC,
  imagePromptA,
  imagePromptB,
  imagePromptC,
  conceptName,
}: DesignImageGalleryProps) {
  const hasAnyImage = imageUrlA || imageUrlB || imageUrlC;

  if (!hasAnyImage) {
    return null;
  }

  const images = [
    { url: imageUrlA, prompt: imagePromptA, ...VARIATIONS[0] },
    { url: imageUrlB, prompt: imagePromptB, ...VARIATIONS[1] },
    { url: imageUrlC ?? null, prompt: imagePromptC ?? null, ...VARIATIONS[2] },
  ];

  // Only show variations that have images or are part of the 3-variation set
  const hasThreeVariations = imageUrlC !== undefined;

  return (
    <Card className="bg-card border-border overflow-hidden shadow-sm">
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground mb-3 font-semibold uppercase tracking-wider">
          AI-Generated Designs — {conceptName}
        </p>
        <div className={`grid gap-3 ${hasThreeVariations ? "grid-cols-3" : "grid-cols-2"}`}>
          {images.slice(0, hasThreeVariations ? 3 : 2).map((img) => (
            <DesignImage
              key={img.key}
              url={img.url}
              prompt={img.prompt}
              label={img.label}
              sublabel={img.sublabel}
              icon={img.icon}
              accentColor={img.accentColor}
              bgAccent={img.bgAccent}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
