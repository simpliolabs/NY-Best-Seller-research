import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle, XCircle, History as HistoryIcon } from 'lucide-react';
import { getReports } from '../api';
import type { ReportSummary } from '../api';

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  completed: { icon: CheckCircle, color: 'text-green-400', label: 'Completed' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  running: { icon: Loader2, color: 'text-yellow-400', label: 'Running' },
};

export default function History() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getReports()
      .then(setReports)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-purple-400" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <HistoryIcon size={20} className="text-purple-400" />
        <h1 className="text-2xl font-bold text-white">Report History</h1>
      </div>

      {reports.length === 0 ? (
        <div className="text-center py-20">
          <HistoryIcon size={48} className="text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400">No pipeline runs yet.</p>
        </div>
      ) : (
        <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/50">
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Date</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Status</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Books</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Top Pick</th>
                <th className="text-right px-5 py-3 text-gray-400 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const cfg = statusConfig[r.status] || statusConfig.failed;
                const Icon = cfg.icon;
                return (
                  <tr
                    key={r.run_id}
                    className="border-b border-gray-700/30 hover:bg-gray-700/20 transition-colors"
                  >
                    <td className="px-5 py-3 text-gray-300">
                      {new Date(r.run_date).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`flex items-center gap-1.5 ${cfg.color}`}>
                        <Icon size={14} className={r.status === 'running' ? 'animate-spin' : ''} />
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-300">{r.books_processed}</td>
                    <td className="px-5 py-3 text-gray-300 truncate max-w-[200px]">
                      {r.top_pick_title || '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {r.status === 'completed' && (
                        <Link
                          to={`/report/${r.run_id}`}
                          className="text-purple-400 hover:text-purple-300 text-xs font-medium"
                        >
                          View Report →
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
