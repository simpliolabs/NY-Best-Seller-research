import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookTrendCharts } from "@/components/BookTrendCharts";

export default function Analytics() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const isNicheWorkspace = activeWorkspace?.workspaceType === "niche_hunter";
  const { data: registry, isLoading } = trpc.analytics.getBookRegistry.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );
  const [selectedIsbn, setSelectedIsbn] = useState<string | null>(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState<string>("");

  const books = registry ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
        <p className="text-muted-foreground mt-1">
          {isNicheWorkspace
            ? "Cross-run signal registry with trend analysis. Click any signal to see score trajectories, community signals, and concept performance over time."
            : "Cross-run book registry with trend analysis. Click any book to see score trajectories, forum signals, and concept performance over time."}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 text-center">
          <p className="text-3xl font-bold text-foreground">{books.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{isNicheWorkspace ? "Unique Signals" : "Unique Books"}</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-3xl font-bold text-foreground">
            {books.reduce((sum, b) => sum + b.appearanceCount, 0)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Total Appearances</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-3xl font-bold text-foreground">
            {books.filter(b => b.winnerConceptCount > 0).length}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{isNicheWorkspace ? "Signals with Winners" : "Books with Winners"}</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-3xl font-bold text-amber-500">
            {books.reduce((sum, b) => sum + b.winnerConceptCount, 0)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Total Winning Concepts</p>
        </Card>
      </div>

      {/* Book Registry Table */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">{isNicheWorkspace ? "Signal Registry" : "Book Registry"}</h2>
          <p className="text-xs text-muted-foreground">{isNicheWorkspace ? "All unique signals tracked across pipeline runs" : "All unique books tracked across pipeline runs, grouped by ISBN"}</p>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">{isNicheWorkspace ? "Loading signal registry..." : "Loading book registry..."}</div>
        ) : books.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">{isNicheWorkspace ? "No signals found. Run the pipeline first." : "No books found. Run the pipeline first."}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left p-3 font-medium text-muted-foreground">{isNicheWorkspace ? "Signal" : "Book"}</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Runs</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Score</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Social</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Novelty</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Audience</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Winners</th>
                  <th className="text-center p-3 font-medium text-muted-foreground">Trends</th>
                </tr>
              </thead>
              <tbody>
                {books.map((book) => (
                  <tr
                    key={book.isbn}
                    className={`border-b border-border/50 hover:bg-muted/20 cursor-pointer transition-colors ${
                      selectedIsbn === book.isbn ? "bg-primary/5 border-primary/20" : ""
                    }`}
                    onClick={() => {
                      setSelectedIsbn(selectedIsbn === book.isbn ? null : book.isbn);
                      setSelectedBookTitle(book.title);
                    }}
                  >
                    <td className="p-3">
                      <div className="flex items-center gap-3">
                        {book.coverUrl ? (
                          <img src={book.coverUrl} alt="" className="w-8 h-12 object-cover rounded shadow-sm" />
                        ) : (
                          <div className="w-8 h-12 bg-muted rounded flex items-center justify-center">
                            <svg className="w-4 h-4 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                            </svg>
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-foreground">{book.title}</p>
                          <p className="text-xs text-muted-foreground">{book.author}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-mono">
                        {book.appearanceCount}
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <ScoreCell value={book.latestScore} max={300} />
                    </td>
                    <td className="p-3 text-center">
                      <ScoreCell value={book.latestSocialMomentum} max={100} />
                    </td>
                    <td className="p-3 text-center">
                      <ScoreCell value={book.latestDesignNovelty} max={100} />
                    </td>
                    <td className="p-3 text-center">
                      <ScoreCell value={book.latestAudienceSize} max={100} />
                    </td>
                    <td className="p-3 text-center">
                      {book.winnerConceptCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                          {book.winnerConceptCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedIsbn(selectedIsbn === book.isbn ? null : book.isbn);
                          setSelectedBookTitle(book.title);
                        }}
                      >
                        {selectedIsbn === book.isbn ? "Hide" : "View"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Trend Charts (expandable) */}
      {selectedIsbn && (
        <BookTrendCharts isbn={selectedIsbn} bookTitle={selectedBookTitle} />
      )}
    </div>
  );
}

// ─── Score Cell ──────────────────────────────────────────────────────────

function ScoreCell({ value, max }: { value: number | null; max: number }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  const pct = Math.min(100, (value / max) * 100);
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-400";

  return (
    <div className="flex items-center gap-1.5 justify-center">
      <div className="h-1.5 w-10 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono w-8 text-right">{value}</span>
    </div>
  );
}
