import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Loader2, Trophy, TrendingUp, Sparkles } from 'lucide-react';
import { getReports, getReportDetails, triggerRun } from '../api';
import type { ReportDetail, ReportSummary } from '../api';
import ColorSwatch from '../components/ColorSwatch';
import TrendBar from '../components/TrendBar';
import ConceptCard from '../components/ConceptCard';

export default function Dashboard() {
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const fetchLatest = async () => {
    try {
      setLoading(true);
      const reports = await getReports();
      const completed = reports.find((r: ReportSummary) => r.status === 'completed');
      if (completed) {
        const detail = await getReportDetails(completed.run_id);
        setReport(detail);
      }
    } catch (err) {
      setError('Failed to load the latest report.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLatest();
  }, []);

  const handleRun = async () => {
    try {
      setRunning(true);
      await triggerRun();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setError('A run is already in progress.');
      } else {
        setError('Failed to start pipeline.');
      }
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-purple-400" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Latest Research Report</h1>
          {report && (
            <p className="text-gray-400 text-sm mt-1">
              {new Date(report.run_date).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
              {' — '}
              {report.books_processed} books analyzed
            </p>
          )}
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {running ? 'Starting...' : 'Run Pipeline Now'}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* No data state */}
      {!report && (
        <div className="text-center py-20">
          <Sparkles size={48} className="text-gray-600 mx-auto mb-4" />
          <h2 className="text-xl text-gray-400 font-medium">No reports yet</h2>
          <p className="text-gray-500 text-sm mt-2">
            Click "Run Pipeline Now" to generate your first design research report.
          </p>
        </div>
      )}

      {/* Top 3 Picks */}
      {report && report.books.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <Trophy size={18} className="text-yellow-400" />
            <h2 className="text-lg font-semibold text-white">Top 3 Picks</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {report.books.slice(0, 3).map((book, idx) => (
              <Link
                key={book.id}
                to={`/book/${book.id}`}
                className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5 hover:border-purple-500/40 transition-colors block"
              >
                <div className="flex gap-4">
                  {book.cover_url && (
                    <img
                      src={book.cover_url}
                      alt={book.title}
                      className="w-16 h-24 object-cover rounded-md shadow-lg shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold text-yellow-400">#{idx + 1}</span>
                      {book.is_sleeper_pick && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full">
                          Sleeper Pick
                        </span>
                      )}
                    </div>
                    <h3 className="text-white font-semibold text-sm truncate">{book.title}</h3>
                    <p className="text-gray-400 text-xs">{book.author}</p>
                    <span className="inline-block mt-1 px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full text-[10px]">
                      {book.subgenre}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <ColorSwatch colors={book.color_palette} size="sm" />
                  <span className="text-lg font-bold text-white">{book.total_score}<span className="text-xs text-gray-500">/15</span></span>
                </div>

                <div className="mt-3">
                  <TrendBar label="Social Momentum" score={book.social_momentum} />
                  <TrendBar label="Design Novelty" score={book.design_novelty} />
                  <TrendBar label="Audience Size" score={book.audience_size} />
                </div>
              </Link>
            ))}
          </div>

          {/* All Books with Concepts */}
          <div className="flex items-center gap-2 mt-6 mb-2">
            <TrendingUp size={18} className="text-purple-400" />
            <h2 className="text-lg font-semibold text-white">All Books & Design Concepts</h2>
          </div>

          {report.books.map((book) => (
            <div key={book.id} className="mb-8">
              <Link
                to={`/book/${book.id}`}
                className="flex items-center gap-3 mb-3 hover:opacity-80 transition-opacity"
              >
                {book.cover_url && (
                  <img src={book.cover_url} alt={book.title} className="w-10 h-14 object-cover rounded" />
                )}
                <div>
                  <h3 className="text-white font-medium text-sm">
                    {book.title}
                    <span className="text-gray-500 font-normal ml-2">by {book.author}</span>
                  </h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded-full">
                      {book.subgenre}
                    </span>
                    <span className="text-xs text-gray-500">Score: {book.total_score}/15</span>
                  </div>
                </div>
              </Link>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {book.concepts.map((concept) => (
                  <ConceptCard key={concept.id} concept={concept} onFavoriteChange={fetchLatest} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
