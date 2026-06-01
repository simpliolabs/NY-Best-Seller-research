import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface TrendBarProps {
  label: string;
  score: number;
  maxScore?: number;
  rationale?: string | null;
  color?: string;
}

export function TrendBar({
  label,
  score,
  maxScore = 100,
  rationale,
  color = "bg-primary",
}: TrendBarProps) {
  const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));

  const bar = (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium text-foreground">{score}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${color} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );

  if (rationale) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{bar}</TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs">{rationale}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return bar;
}
