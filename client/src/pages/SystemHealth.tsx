import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Clock,
  Zap,
  AlertCircle,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";

export default function SystemHealth() {
  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = trpc.health.status.useQuery();
  const { data: circuits, isLoading: circuitsLoading, refetch: refetchCircuits } = trpc.health.circuits.useQuery();
  const { data: healingLogs, isLoading: logsLoading, refetch: refetchLogs } = trpc.health.healingLog.useQuery({ limit: 20 });
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetchHealth(), refetchCircuits(), refetchLogs()]);
    setRefreshing(false);
  };

  const getCircuitIcon = (isOpen: boolean) => {
    if (isOpen) return <ShieldX className="h-5 w-5 text-red-500" />;
    return <ShieldCheck className="h-5 w-5 text-emerald-500" />;
  };

  const getResultBadge = (result: string) => {
    if (result === "healed" || result === "recovered") {
      return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">{result}</Badge>;
    }
    if (result === "degraded" || result === "fallback") {
      return <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20">{result}</Badge>;
    }
    return <Badge variant="destructive">{result}</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-emerald-500" />
            System Health
          </h1>
          <p className="text-muted-foreground mt-1">
            Self-healing status, circuit breakers, and recovery log
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Overall Health Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Overall Status</CardTitle>
        </CardHeader>
        <CardContent>
          {healthLoading ? (
            <div className="animate-pulse h-20 bg-muted rounded" />
          ) : health ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                {health.overall === "healthy" ? (
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                ) : health.overall === "degraded" ? (
                  <AlertCircle className="h-8 w-8 text-amber-500" />
                ) : (
                  <XCircle className="h-8 w-8 text-red-500" />
                )}
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className="font-semibold capitalize">{health.overall}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <Clock className="h-8 w-8 text-blue-500" />
                <div>
                  <p className="text-xs text-muted-foreground">Uptime</p>
                  <p className="font-semibold">{health.lastHealAt ? new Date(health.lastHealAt).toLocaleTimeString() : "N/A"}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <Zap className="h-8 w-8 text-amber-500" />
                <div>
                  <p className="text-xs text-muted-foreground">Open Circuits</p>
                  <p className="font-semibold">{health.subsystems.filter((s: any) => s.status !== "healthy").length}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <ShieldAlert className="h-8 w-8 text-purple-500" />
                <div>
                  <p className="text-xs text-muted-foreground">Healings (24h)</p>
                  <p className="font-semibold">{health.recentHeals ?? 0}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">Unable to fetch health status</p>
          )}
        </CardContent>
      </Card>

      {/* Circuit Breakers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Circuit Breakers</CardTitle>
        </CardHeader>
        <CardContent>
          {circuitsLoading ? (
            <div className="animate-pulse space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 bg-muted rounded" />
              ))}
            </div>
          ) : circuits && circuits.length > 0 ? (
            <div className="space-y-2">
              {circuits.map((circuit: any) => (
                <div
                  key={circuit.name}
                  className="flex items-center justify-between p-3 rounded-lg border border-border"
                >
                  <div className="flex items-center gap-3">
                    {getCircuitIcon(circuit.isOpen)}
                    <div>
                      <p className="font-medium text-sm">{circuit.name.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}</p>
                      <p className="text-xs text-muted-foreground">
                        {circuit.failures} failures
                        {circuit.lastFailure && ` · Last: ${new Date(circuit.lastFailure).toLocaleString()}`}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant={circuit.isOpen ? "destructive" : "outline"}
                    className={circuit.isOpen ? "" : "border-emerald-500/30 text-emerald-500"}
                  >
                    {circuit.isOpen ? "OPEN (blocking)" : "CLOSED (healthy)"}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No circuit breakers configured</p>
          )}
        </CardContent>
      </Card>

      {/* Healing Log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recovery Log</CardTitle>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="animate-pulse space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-muted rounded" />
              ))}
            </div>
          ) : healingLogs && healingLogs.length > 0 ? (
            <div className="space-y-2">
              {healingLogs.map((log: any) => (
                <div
                  key={log.id}
                  className="p-3 rounded-lg border border-border"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {log.subsystem}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {log.classification}
                      </Badge>
                      {getResultBadge(log.result)}
                    </div>
                    {log.mttrSeconds != null && (
                      <span className="text-xs text-muted-foreground">
                        MTTR: {log.mttrSeconds.toFixed(1)}s
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium">{log.issue}</p>
                  <p className="text-xs text-muted-foreground mt-1">{log.actionTaken}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-muted-foreground">
                      {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
                    </span>
                    {log.runId && (
                      <span className="text-xs text-muted-foreground">Run #{log.runId}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No healing events recorded yet. The system will log recovery actions here when issues are detected and auto-resolved.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
