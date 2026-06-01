import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ColorSwatchProps {
  colors: string[];
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
  lg: "h-9 w-9",
};

export function ColorSwatch({ colors, size = "md" }: ColorSwatchProps) {
  if (!colors || colors.length === 0) return null;

  return (
    <div className="flex gap-1.5 items-center">
      {colors.map((color, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <div
              className={`${sizeMap[size]} rounded-md border border-border/50 shadow-sm transition-transform hover:scale-110`}
              style={{ backgroundColor: color }}
            />
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-mono text-xs">{color}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
