import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Loader2, ArrowLeft, Trophy } from 'lucide-react';
import { getReportDetails } from '../api';
import type { ReportDetail as ReportDetailType } from '../api';
import ColorSwatch from '../components/ColorSwatch';
import ConceptCard from '../components/ConceptCard';

export default function ReportDetail() {
  const { runId } = useParams<{ runId: string }>();
  const [report, setReport] = useState<ReportDetailType | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchReport = async () => {
    if (!runId) return;
    try {
      setLoading(true);
      const data = await getReportDetails(Number(runId));
      setReport(data);
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [runId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-purple-400" size={32} />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400">Report not found.</p>
        <Link to="/history" className="text-purple-400 text-sm mt-2 inline-block">
          ← Back to History
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Link to="/history" className="flex items-center gap-1.5 text-gray-400 hover:text-purple-300 text-sm transition-colors">
        <ArrowLeft size={14} />
        Back to History
      </Link>

      <div>
        <h1 className="text-2xl font-bold text-white">
          Report — {new Date(report.run_date).toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </h1>
        <p className="text-gray-400 text-sm mt-1">{report.books_processed} books analyzed</p>
      </div>

      {/* Top 3 */}
      {report.books.length > 0 && (
        <>
          <div className="flex items-center gap-2">
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
                <div className="flex gap-3">
                  {book.cover_url && (
                    <img src={book.cover_url} alt={book.title} className="w-14 h-20 object-cover rounded-md shadow-lg shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-yellow-400">#{idx + 1}</span>
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
              </Link>
            ))}
          </div>
        </>
      )}

      {/* All Books with Concepts */}
      {report.books.map((book) => (
        <div key={book.id} className="mb-6">
          <Link to={`/book/${book.id}`} className="flex items-center gap-3 mb-3 hover:opacity-80 transition-opacity">
            {book.cover_url && (
              <img src={book.cover_url} alt={book.title} className="w-10 h-14 object-cover rounded" />
            )}
            <div>
              <h3 className="text-white font-medium text-sm">
                {book.title}
                <span className="text-gray-500 font-normal ml-2">by {book.author}</span>
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded-full">{book.subgenre}</span>
                <span className="text-xs text-gray-500">Score: {book.total_score}/15</span>
              </div>
            </div>
          </Link>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {book.concepts.map((concept) => (
              <ConceptCard key={concept.id} concept={concept} onFavoriteChange={fetchReport} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
