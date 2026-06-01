import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocation } from "wouter";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { History as HistoryIcon, CheckCircle, XCircle, Loader2, Image as ImageIcon } from "lucide-react";

const statusConfig = {
  completed: { icon: CheckCircle, label: "Completed", variant: "default" as const, className: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  failed: { icon: XCircle, label: "Failed", variant: "destructive" as const, className: "bg-red-100 text-red-700 border-red-300" },
  running: { icon: Loader2, label: "Running", variant: "secondary" as const, className: "bg-amber-100 text-amber-700 border-amber-300" },
};

export default function History() {
  const [, setLocation] = useLocation();
  const { activeWorkspace } = useWorkspace();
  const slug = activeWorkspace?.slug ?? "";
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const { data: runs, isLoading } = trpc.reports.listHistory.useQuery({ workspaceId: activeWorkspace?.id });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <HistoryIcon className="h-6 w-6 text-primary" /> Report History
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          All past pipeline runs and their results.
          {runs && runs.length > 0 && ` (${runs.length} total runs)`}
        </p>
      </div>

      {!runs || runs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <HistoryIcon className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Runs Yet</h3>
            <p className="text-sm text-muted-foreground">
              Pipeline runs will appear here once you trigger your first run.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-center">{isNicheWorkspace ? "Signals" : "Books"}</TableHead>
                <TableHead className="text-center">Stages</TableHead>
                <TableHead className="text-center">
                  <span className="flex items-center justify-center gap-1">
                    <ImageIcon className="h-3.5 w-3.5" /> Images
                  </span>
                </TableHead>
                <TableHead>Top Pick</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run: any) => {
                const cfg = statusConfig[run.status as keyof typeof statusConfig] ?? statusConfig.running;
                const StatusIcon = cfg.icon;
                return (
                  <TableRow
                    key={run.id}
                    className="cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => setLocation(`/${slug}/report/${run.id}`)}
                  >
                    <TableCell className="font-mono text-sm">#{run.id}</TableCell>
                    <TableCell>
                      <Badge variant={cfg.variant} className={cfg.className}>
                        <StatusIcon className={`h-3 w-3 mr-1 ${run.status === "running" ? "animate-spin" : ""}`} />
                        {cfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-center font-mono">{run.booksProcessed}</TableCell>
                    <TableCell className="text-center font-mono text-xs text-muted-foreground">
                      {run.currentStage ?? "—"}/{run.totalStages ?? 7}
                    </TableCell>
                    <TableCell className="text-center font-mono">
                      {run.imagesGenerated ?? 0}
                    </TableCell>
                    <TableCell className="text-sm max-w-[200px] truncate">
                      {run.topPickTitle || "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
