import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
  ComposedChart,
  Area,
} from "recharts";

interface BookTrendChartsProps {
  isbn: string;
  bookTitle: string;
}

const TIME_RANGES = [
  { label: "30d", days: 30 },
  { label: "60d", days: 60 },
  { label: "90d", days: 90 },
  { label: "All", days: undefined },
] as const;

export function BookTrendCharts({ isbn, bookTitle }: BookTrendChartsProps) {
  const [days, setDays] = useState<number | undefined>(undefined);

  const { data, isLoading } = trpc.analytics.getBookTrends.useQuery(
    { isbn, days },
  );

  const dataPoints = data?.dataPoints ?? [];

  // Format data for charts
  const chartData = dataPoints.map((dp) => {
    const date = new Date(dp.runDate);
    const forumSignals = dp.forumSignals as any;

    return {
      date: `${date.getMonth() + 1}/${date.getDate()}`,
      fullDate: date.toLocaleDateString(),
      // Score trajectory
      total: dp.trendScoreTotal,
      social: dp.socialMomentum,
      novelty: dp.designNovelty,
      audience: dp.audienceSize,
      // Forum signals
      redditPosts: forumSignals?.reddit?.postCount ?? 0,
      redditUpvotes: forumSignals?.reddit?.avgUpvotes ?? 0,
      goodreadsRating: forumSignals?.goodreads?.rating ?? 0,
      goodreadsReviews: forumSignals?.goodreads?.reviewCount ?? 0,
      // Concept signals
      conceptCount: dp.conceptCount,
      avgScore: dp.avgConceptScore,
      maxScore: dp.maxConceptScore,
      winnerCount: dp.winnerCount,
    };
  });

  return (
    <Card className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Trend Analysis: {bookTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {dataPoints.length} data point{dataPoints.length !== 1 ? "s" : ""} across pipeline runs
          </p>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-0.5">
          {TIME_RANGES.map((range) => (
            <Button
              key={range.label}
              variant="ghost"
              size="sm"
              className={`h-7 text-xs px-3 ${
                days === range.days
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">
          Loading trend data...
        </div>
      ) : chartData.length < 2 ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="font-medium">Not enough data points yet</p>
            <p className="text-xs mt-1">Run the pipeline at least 2 times to see trends</p>
            {chartData.length === 1 && (
              <div className="mt-4 grid grid-cols-3 gap-4 text-left">
                <div className="bg-muted/50 p-3 rounded-lg">
                  <p className="text-xs text-muted-foreground">Social Momentum</p>
                  <p className="text-lg font-bold">{chartData[0].social ?? "—"}</p>
                </div>
                <div className="bg-muted/50 p-3 rounded-lg">
                  <p className="text-xs text-muted-foreground">Design Novelty</p>
                  <p className="text-lg font-bold">{chartData[0].novelty ?? "—"}</p>
                </div>
                <div className="bg-muted/50 p-3 rounded-lg">
                  <p className="text-xs text-muted-foreground">Audience Size</p>
                  <p className="text-lg font-bold">{chartData[0].audience ?? "—"}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Chart 1: Score Trajectory */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-1">Score Trajectory</h4>
            <p className="text-xs text-muted-foreground mb-3">Social Momentum, Design Novelty, and Audience Size over time</p>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "11px" }} />
                <Line type="monotone" dataKey="social" name="Social Momentum" stroke="#f59e0b" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="novelty" name="Design Novelty" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="audience" name="Audience Size" stroke="#06b6d4" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 2: Forum Signal Strength */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-1">Forum Signal Strength</h4>
            <p className="text-xs text-muted-foreground mb-3">Reddit mentions and Goodreads ratings over time</p>
            <ResponsiveContainer width="100%" height={250}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis yAxisId="right" orientation="right" domain={[0, 5]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "11px" }} />
                <Bar yAxisId="left" dataKey="redditPosts" name="Reddit Posts" fill="#ff6b35" opacity={0.7} />
                <Line yAxisId="right" type="monotone" dataKey="goodreadsRating" name="Goodreads Rating" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 3: Concept Signal Strength */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-1">Concept Signal Strength</h4>
            <p className="text-xs text-muted-foreground mb-3">Average concept score, max score, and concept count per run</p>
            <ResponsiveContainer width="100%" height={250}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "11px" }} />
                <Area yAxisId="left" type="monotone" dataKey="avgScore" name="Avg Score" fill="#8b5cf6" fillOpacity={0.1} stroke="#8b5cf6" strokeWidth={2} />
                <Line yAxisId="left" type="monotone" dataKey="maxScore" name="Max Score" stroke="#f59e0b" strokeWidth={2} dot={{ r: 4 }} />
                <Bar yAxisId="right" dataKey="conceptCount" name="Concepts" fill="#06b6d4" opacity={0.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
