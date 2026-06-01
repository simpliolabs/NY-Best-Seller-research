import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, Minus, ShoppingBag } from "lucide-react";

interface EtsyValidationBadgeProps {
  saturationLevel: "low" | "medium" | "high" | null;
  listingCount?: number | null;
  avgPrice?: string | null;
  minPrice?: string | null;
  maxPrice?: string | null;
  topFavorites?: number | null;
  searchKeywords?: string | null;
  compact?: boolean;
}

const saturationConfig = {
  low: {
    label: "Low Competition",
    color: "bg-emerald-100 text-emerald-700 border-emerald-300",
    icon: TrendingUp,
    description: "Wide open market — few competitors",
  },
  medium: {
    label: "Moderate",
    color: "bg-amber-100 text-amber-700 border-amber-300",
    icon: Minus,
    description: "Some competition — differentiation needed",
  },
  high: {
    label: "Saturated",
    color: "bg-red-100 text-red-700 border-red-300",
    icon: TrendingDown,
    description: "Crowded market — strong concept required",
  },
};

export function EtsyValidationBadge({
  saturationLevel,
  listingCount,
  avgPrice,
  minPrice,
  maxPrice,
  topFavorites,
  searchKeywords,
  compact = false,
}: EtsyValidationBadgeProps) {
  if (!saturationLevel) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-xs text-muted-foreground border-border/50">
            <ShoppingBag className="h-3 w-3 mr-1" />
            Etsy: Skipped
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs p-2">
          <p className="text-xs">Etsy market validation was skipped — API key is not yet active. Data will appear here once the key is approved.</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  const config = saturationConfig[saturationLevel];
  const Icon = config.icon;

  const badge = (
    <Badge
      variant="outline"
      className={`text-xs ${config.color} ${compact ? "px-1.5 py-0.5" : ""}`}
    >
      <Icon className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} mr-1`} />
      {compact ? saturationLevel.charAt(0).toUpperCase() + saturationLevel.slice(1) : config.label}
    </Badge>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs p-3" side="top">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-primary" />
            <span className="font-medium text-sm">Etsy Market Data</span>
          </div>
          <p className="text-xs text-muted-foreground">{config.description}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {listingCount != null && (
              <>
                <span className="text-muted-foreground">Listings:</span>
                <span className="font-mono font-medium">
                  {listingCount.toLocaleString()}
                </span>
              </>
            )}
            {avgPrice && (
              <>
                <span className="text-muted-foreground">Avg Price:</span>
                <span className="font-mono font-medium">${parseFloat(avgPrice).toFixed(2)}</span>
              </>
            )}
            {minPrice && maxPrice && (
              <>
                <span className="text-muted-foreground">Range:</span>
                <span className="font-mono font-medium">
                  ${parseFloat(minPrice).toFixed(2)} – ${parseFloat(maxPrice).toFixed(2)}
                </span>
              </>
            )}
            {topFavorites != null && topFavorites > 0 && (
              <>
                <span className="text-muted-foreground">Top Favorites:</span>
                <span className="font-mono font-medium">
                  {topFavorites.toLocaleString()}
                </span>
              </>
            )}
          </div>
          {searchKeywords && (
            <p className="text-[10px] text-muted-foreground/70 pt-1 border-t border-border/50">
              Search: "{searchKeywords}"
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
