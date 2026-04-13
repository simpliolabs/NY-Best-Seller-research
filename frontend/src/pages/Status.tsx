import { useEffect, useState } from 'react';
import { Loader2, Activity, CheckCircle, XCircle, Clock, RefreshCw } from 'lucide-react';
import { getStatus } from '../api';
import type { RunStatus } from '../api';

const stageLabels = [
  'Initializing...',
  'Stage 1 of 5: Fetching NYT Best Sellers',
  'Stage 2 of 5: Extracting Metadata with AI',
  'Stage 3 of 5: Generating Design Concepts',
  'Stage 4 of 5: Scoring Trends',
  'Stage 5 of 5: Saving Report & Delivering',
];

export default function Status() {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStatus = async () => {
    try {
      const data = await getStatus();
      setStatus(data);
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Auto-refresh every 3 seconds when a run is active
  useEffect(() => {
    if (!autoRefresh || status?.status !== 'running') return;
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, status?.status]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-purple-400" size={32} />
      </div>
    );
  }

  const isRunning = status?.status === 'running';
  const isCompleted = status?.status === 'completed';
  const isFailed = status?.status === 'failed';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-purple-400" />
          <h1 className="text-2xl font-bold text-white">Run Status</h1>
        </div>
        <button
          onClick={fetchStatus}
          className="flex items-center gap-1.5 text-gray-400 hover:text-purple-300 text-xs transition-colors"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {status?.status === 'no_runs' ? (
        <div className="text-center py-20">
          <Clock size={48} className="text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400">No pipeline runs yet.</p>
          <p className="text-gray-500 text-sm mt-1">
            Go to the Dashboard and click "Run Pipeline Now" to start.
          </p>
        </div>
      ) : (
        <>
          {/* Current Status Card */}
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              {isRunning && <Loader2 size={20} className="animate-spin text-yellow-400" />}
              {isCompleted && <CheckCircle size={20} className="text-green-400" />}
              {isFailed && <XCircle size={20} className="text-red-400" />}
              <div>
                <h2 className="text-white font-semibold text-sm">
                  Run #{status?.run_id}
                  {isRunning && <span className="text-yellow-400 ml-2">In Progress</span>}
                  {isCompleted && <span className="text-green-400 ml-2">Completed</span>}
                  {isFailed && <span className="text-red-400 ml-2">Failed</span>}
                </h2>
                <p className="text-gray-500 text-xs">
                  Started: {status?.run_date ? new Date(status.run_date).toLocaleString() : 'N/A'}
                </p>
              </div>
            </div>

            {/* Stage Progress */}
            <div className="space-y-2">
              {stageLabels.map((label, idx) => {
                const currentStage = status?.current_stage || 0;
                const isActive = idx === currentStage && isRunning;
                const isDone = idx < currentStage || (idx === currentStage && isCompleted);
                const isPending = idx > currentStage;

                return (
                  <div
                    key={idx}
                    className={`flex items-center gap-3 px-4 py-2 rounded-lg text-xs transition-colors ${
                      isActive
                        ? 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-300'
                        : isDone
                        ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                        : isFailed && idx === currentStage
                        ? 'bg-red-500/10 border border-red-500/30 text-red-400'
                        : 'bg-gray-800/30 border border-gray-700/30 text-gray-500'
                    }`}
                  >
                    {isActive && <Loader2 size={12} className="animate-spin shrink-0" />}
                    {isDone && <CheckCircle size={12} className="shrink-0" />}
                    {isFailed && idx === currentStage && <XCircle size={12} className="shrink-0" />}
                    {isPending && !isFailed && <Clock size={12} className="shrink-0" />}
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>

            {/* Stage Label */}
            {status?.stage_label && (
              <p className="text-gray-400 text-xs mt-4">
                <span className="text-gray-500">Current status:</span> {status.stage_label}
              </p>
            )}
          </div>

          {/* Error Log */}
          {isFailed && status?.error_log && (
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-5">
              <h3 className="text-red-400 font-semibold text-sm mb-2">Error Log</h3>
              <pre className="text-red-300/80 text-[11px] leading-relaxed whitespace-pre-wrap font-mono overflow-x-auto max-h-64 overflow-y-auto">
                {status.error_log}
              </pre>
            </div>
          )}

          {/* Schedule Info */}
          <div className="bg-gray-800/30 border border-gray-700/40 rounded-xl p-5">
            <h3 className="text-gray-300 font-semibold text-sm mb-2">Schedule Info</h3>
            <div className="text-xs text-gray-500 space-y-1">
              <p>
                <span className="text-gray-400">Last run:</span>{' '}
                {status?.run_date ? new Date(status.run_date).toLocaleString() : 'Never'}
              </p>
              <p>
                <span className="text-gray-400">Schedule:</span> Every Monday at 9:00 AM ET (via GitHub Actions)
              </p>
              <p>
                <span className="text-gray-400">Books processed:</span> {status?.books_processed || 0}
              </p>
            </div>
          </div>

          {/* Auto-refresh toggle */}
          {isRunning && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              <span>Auto-refresh every 3 seconds</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
