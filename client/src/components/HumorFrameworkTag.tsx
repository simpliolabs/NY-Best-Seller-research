import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Users, Palette, Lightbulb, Ban, ArrowRightLeft } from "lucide-react";

type HumorFramework =
  | "cultural-insider"
  | "style-forward"
  | "white-space"
  | "anti-joke"
  | "cross-reference";

const frameworkConfig: Record<
  HumorFramework,
  {
    label: string;
    color: string;
    icon: React.ComponentType<{ className?: string }>;
    description: string;
  }
> = {
  "cultural-insider": {
    label: "Cultural Insider",
    color: "bg-violet-100 text-violet-700 border-violet-300",
    icon: Users,
    description:
      "Based on inside jokes, catchphrases, or identity markers from the fan community.",
  },
  "style-forward": {
    label: "Style Forward",
    color: "bg-emerald-100 text-emerald-700 border-emerald-300",
    icon: Palette,
    description:
      "Built around the most resonating design aesthetic for this audience.",
  },
  "white-space": {
    label: "White Space",
    color: "bg-amber-100 text-amber-700 border-amber-300",
    icon: Lightbulb,
    description:
      "Targets an untapped angle, format, or audience that no one has explored.",
  },
  "anti-joke": {
    label: "Anti-Joke",
    color: "bg-red-100 text-red-700 border-red-300",
    icon: Ban,
    description:
      'Self-deprecating fan humor: "Things you should NOT do when..." format.',
  },
  "cross-reference": {
    label: "Cross-Reference",
    color: "bg-sky-100 text-sky-700 border-sky-300",
    icon: ArrowRightLeft,
    description:
      "Combines a trending fandom element with a broader cultural trend.",
  },
};

interface HumorFrameworkTagProps {
  framework: string | null;
  showTooltip?: boolean;
  compact?: boolean;
}

export function HumorFrameworkTag({
  framework,
  showTooltip = true,
  compact = false,
}: HumorFrameworkTagProps) {
  if (!framework) return null;

  const config = frameworkConfig[framework as HumorFramework];
  if (!config) {
    return (
      <Badge variant="outline" className="text-xs">
        {framework}
      </Badge>
    );
  }

  const Icon = config.icon;

  const badge = (
    <Badge
      variant="outline"
      className={`text-xs ${config.color} ${compact ? "px-1.5 py-0.5" : ""}`}
    >
      <Icon className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} mr-1`} />
      {config.label}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="text-xs">{config.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}
