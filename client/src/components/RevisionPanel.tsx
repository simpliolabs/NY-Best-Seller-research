/**
 * RevisionPanel — Phase G
 * Side-by-side image comparison with revision instruction input and history timeline.
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  RotateCcw,
  Check,
  Loader2,
  Sparkles,
  History,
  ArrowRight,
  Scissors,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";

interface RevisionPanelProps {
  conceptId: number;
  variationKey: "A" | "B" | "C";
  originalImageUrl: string;
  conceptName: string;
}

export function RevisionPanel({
  conceptId,
  variationKey,
  originalImageUrl,
  conceptName,
}: RevisionPanelProps) {
  const [instruction, setInstruction] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const utils = trpc.useUtils();

  const historyQuery = trpc.revision.getHistory.useQuery(
    { conceptId, variationKey },
    { enabled: true }
  );

  const trimAndCleanMutation = trpc.revision.trimAndClean.useMutation({
    onSuccess: () => {
      toast.success("Clean & Trim done!");
      utils.revision.getHistory.invalidate({ conceptId, variationKey });
    },
    onError: (err) => {
      toast.error(`Clean & Trim failed: ${err.message}`);
    },
  });

  const submitMutation = trpc.revision.submitRevision.useMutation({
    onSuccess: (data) => {
      toast.success("Revision generated!");
      setInstruction("");
      utils.revision.getHistory.invalidate({ conceptId, variationKey });
    },
    onError: (err) => {
      toast.error(`Revision failed: ${err.message}`);
    },
  });

  const acceptMutation = trpc.revision.acceptDesign.useMutation({
    onSuccess: () => {
      toast.success("Design accepted!");
      utils.revision.getHistory.invalidate({ conceptId, variationKey });
    },
    onError: (err) => {
      toast.error(`Accept failed: ${err.message}`);
    },
  });

  const revertMutation = trpc.revision.revertToOriginal.useMutation({
    onSuccess: () => {
      toast.success("Reverted to original");
      utils.revision.getHistory.invalidate({ conceptId, variationKey });
    },
    onError: (err) => {
      toast.error(`Revert failed: ${err.message}`);
    },
  });

  const revisions = historyQuery.data ?? [];
  const latestRevision = revisions[0] ?? null;
  const acceptedRevision = revisions.find((r) => r.accepted) ?? null;

  // The "current" image is the latest revision result, or the original
  const currentImageUrl = latestRevision?.resultImageUrl ?? originalImageUrl;
  const isOriginal = !latestRevision;

  const variationLabel =
    variationKey === "A"
      ? "Clean / Commercial"
      : variationKey === "B"
        ? "Bold / Artistic"
        : "Trending / Social";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            Variation {variationKey}
          </Badge>
          <span className="text-sm text-muted-foreground">{variationLabel}</span>
          {revisions.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {revisions.length} revision{revisions.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {revisions.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowHistory(!showHistory)}
              >
                <History className="h-4 w-4 mr-1" />
                {showHistory ? "Hide" : "Show"} History
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revertMutation.mutate({ conceptId, variationKey })}
                disabled={revertMutation.isPending}
              >
                <RotateCcw className="h-4 w-4 mr-1" />
                Revert
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 gap-4">
        {/* Original */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Original</span>
            {isOriginal && (
              <Badge className="text-xs bg-green-100 text-green-800">Current</Badge>
            )}
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <div className="relative aspect-square rounded-lg border overflow-hidden bg-muted/30 cursor-zoom-in">
                <img
                  src={originalImageUrl}
                  alt={`${conceptName} — Original ${variationKey}`}
                  className="w-full h-full object-contain"
                />
              </div>
            </DialogTrigger>
            <DialogContent className="max-w-4xl p-2 bg-card">
              <img src={originalImageUrl} alt={`${conceptName} — Original ${variationKey}`} className="w-full rounded-lg" />
            </DialogContent>
          </Dialog>
        </div>

        {/* Latest revision (or placeholder) */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {latestRevision ? `Revision #${latestRevision.iterationNumber}` : "Revised"}
            </span>
            {latestRevision && !isOriginal && (
              <Badge className="text-xs bg-blue-100 text-blue-800">Latest</Badge>
            )}
            {acceptedRevision && (
              <Badge className="text-xs bg-green-100 text-green-800">
                <Check className="h-3 w-3 mr-0.5" />
                Accepted
              </Badge>
            )}
          </div>
          <div className="relative aspect-square rounded-lg border overflow-hidden bg-muted/30">
            {latestRevision ? (
              <Dialog>
                <DialogTrigger asChild>
                  <img
                    src={latestRevision.resultImageUrl}
                    alt={`${conceptName} — Revision ${latestRevision.iterationNumber}`}
                    className="w-full h-full object-contain cursor-zoom-in"
                  />
                </DialogTrigger>
                <DialogContent className="max-w-4xl p-2 bg-card">
                  <img src={latestRevision.resultImageUrl} alt={`${conceptName} — Revision ${latestRevision.iterationNumber}`} className="w-full rounded-lg" />
                </DialogContent>
              </Dialog>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <div className="text-center space-y-2">
                  <Sparkles className="h-8 w-8 mx-auto opacity-40" />
                  <p className="text-sm">Submit a revision instruction below</p>
                </div>
              </div>
            )}
          </div>
          {/* Accept button for latest revision */}
          {latestRevision && !acceptedRevision && (
            <Button
              size="sm"
              className="w-full"
              onClick={() => acceptMutation.mutate({ revisionId: latestRevision.id })}
              disabled={acceptMutation.isPending}
            >
              {acceptMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              Accept This Revision
            </Button>
          )}
        </div>
      </div>

      {/* Revision instruction input */}
      <div className="space-y-2">
        <Textarea
          placeholder="Describe what to change... e.g. 'Make the text bolder and add a vintage texture'"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          className="resize-none"
        />
        <div className="flex gap-2">
          <Button
            onClick={() =>
              submitMutation.mutate({
                conceptId,
                variationKey,
                instruction,
              })
            }
            disabled={!instruction.trim() || submitMutation.isPending || trimAndCleanMutation.isPending}
            className="flex-1"
          >
            {submitMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Generating revision...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Generate Revision
              </>
            )}
          </Button>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() =>
                    trimAndCleanMutation.mutate({ conceptId, variationKey })
                  }
                  disabled={trimAndCleanMutation.isPending || submitMutation.isPending}
                  className="shrink-0"
                >
                  {trimAndCleanMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Scissors className="h-4 w-4" />
                  )}
                  <span className="ml-2">Clean &amp; Trim</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                Remove faint text + trim — no AI, keeps the design exactly the same.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Revision history timeline */}
      {showHistory && revisions.length > 0 && (
        <>
          <Separator />
          <div className="space-y-3">
            <h4 className="text-sm font-medium flex items-center gap-1">
              <History className="h-4 w-4" />
              Revision History
            </h4>
            <div className="space-y-2">
              {revisions.map((rev) => (
                <div
                  key={rev.id}
                  className="flex items-start gap-3 p-3 rounded-lg border bg-card"
                >
                  <img
                    src={rev.resultImageUrl}
                    alt={`Revision ${rev.iterationNumber}`}
                    className="w-16 h-16 rounded object-contain border bg-muted/30"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        #{rev.iterationNumber}
                      </span>
                      {rev.accepted && (
                        <Badge className="text-xs bg-green-100 text-green-800">
                          Accepted
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(rev.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {rev.instruction && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {rev.instruction}
                      </p>
                    )}
                  </div>
                  {!rev.accepted && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => acceptMutation.mutate({ revisionId: rev.id })}
                      disabled={acceptMutation.isPending}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
