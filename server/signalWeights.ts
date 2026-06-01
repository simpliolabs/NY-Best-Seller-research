/**
 * Signal Weights — Style-Faithful Pipeline
 * Karpathy P2: pure data transformation, no I/O, no side effects.
 *
 * Computes a human-readable style preferences summary from the approval/rejection
 * history of trend patterns. Used by the UI "Style Preferences" card.
 */
import type { TrendPattern } from "../drizzle/schema";

export interface SignalWeight {
  label: string;
  count: number;
  type: "approval" | "rejection";
}

export interface StylePreferencesSummary {
  approvalSignals: SignalWeight[];
  rejectionSignals: SignalWeight[];
  totalApprovals: number;
  totalRejections: number;
  hasEnoughData: boolean;
}

// Canonical tag labels for display
const TAG_LABELS: Record<string, string> = {
  // Approval tags
  great_style: "Great style",
  perfect_subject: "Perfect subject",
  strong_humor: "Strong humor",
  niche_authentic: "Niche authentic",
  clean_composition: "Clean composition",
  love_colors: "Love the colors",
  // Rejection tags
  wrong_style: "Wrong style",
  bad_subject: "Bad subject",
  weak_humor: "Weak humor",
  off_brand: "Off-brand",
  poor_composition: "Poor composition",
  bad_colors: "Bad colors",
  too_generic: "Too generic",
  transfer_failed: "Transfer failed",
};

/**
 * Compute style preference weights from a list of trend patterns.
 * Counts tag occurrences across all approved/dismissed patterns.
 * Returns sorted by count descending, top 6 per category.
 */
export function computeSignalWeights(patterns: TrendPattern[]): StylePreferencesSummary {
  const approvalCounts = new Map<string, number>();
  const rejectionCounts = new Map<string, number>();

  let totalApprovals = 0;
  let totalRejections = 0;

  for (const p of patterns) {
    if (p.status === "approved") {
      totalApprovals++;
      const tags = (p.approvalTags as string[] | null) ?? [];
      for (const tag of tags) {
        approvalCounts.set(tag, (approvalCounts.get(tag) ?? 0) + 1);
      }
    } else if (p.status === "dismissed") {
      totalRejections++;
      const tags = (p.rejectionTags as string[] | null) ?? [];
      for (const tag of tags) {
        rejectionCounts.set(tag, (rejectionCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const toSignals = (map: Map<string, number>, type: "approval" | "rejection"): SignalWeight[] =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag, count]) => ({
        label: TAG_LABELS[tag] ?? tag,
        count,
        type,
      }));

  return {
    approvalSignals: toSignals(approvalCounts, "approval"),
    rejectionSignals: toSignals(rejectionCounts, "rejection"),
    totalApprovals,
    totalRejections,
    hasEnoughData: totalApprovals + totalRejections >= 3,
  };
}
