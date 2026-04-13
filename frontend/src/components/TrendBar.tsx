interface TrendBarProps {
  label: string;
  score: number;
  maxScore?: number;
  rationale?: string;
}

const colorMap: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-orange-500',
  3: 'bg-yellow-500',
  4: 'bg-emerald-500',
  5: 'bg-green-400',
};

export default function TrendBar({ label, score, maxScore = 5, rationale }: TrendBarProps) {
  const pct = (score / maxScore) * 100;

  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">{label}</span>
        <span className="text-white font-semibold">{score}/{maxScore}</span>
      </div>
      <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${colorMap[score] || 'bg-gray-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {rationale && (
        <p className="text-[11px] text-gray-500 mt-0.5 leading-tight">{rationale}</p>
      )}
    </div>
  );
}
