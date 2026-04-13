import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Loader2, ArrowLeft, Tag } from 'lucide-react';
import { getBook } from '../api';
import type { Book } from '../api';
import ColorSwatch from '../components/ColorSwatch';
import TrendBar from '../components/TrendBar';
import ConceptCard from '../components/ConceptCard';

export default function BookDetail() {
  const { id } = useParams<{ id: string }>();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBook = async () => {
    if (!id) return;
    try {
      setLoading(true);
      const data = await getBook(Number(id));
      setBook(data);
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBook();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-purple-400" size={32} />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400">Book not found.</p>
        <Link to="/" className="text-purple-400 text-sm mt-2 inline-block">
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link to="/" className="flex items-center gap-1.5 text-gray-400 hover:text-purple-300 text-sm transition-colors">
        <ArrowLeft size={14} />
        Back to Dashboard
      </Link>

      {/* Book Header */}
      <div className="flex gap-6">
        {book.cover_url && (
          <img
            src={book.cover_url}
            alt={book.title}
            className="w-32 h-48 object-cover rounded-xl shadow-xl shrink-0"
          />
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold text-yellow-400">#{book.rank}</span>
            {book.is_sleeper_pick && (
              <span className="text-[10px] px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full font-medium">
                Sleeper Pick
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-white">{book.title}</h1>
          <p className="text-gray-400 text-sm mt-0.5">{book.author}</p>
          <span className="inline-block mt-2 px-2.5 py-1 bg-purple-500/20 text-purple-300 rounded-full text-xs font-medium">
            {book.subgenre}
          </span>

          {/* Tropes */}
          <div className="flex flex-wrap gap-1.5 mt-3">
            {book.tropes.map((trope, i) => (
              <span
                key={i}
                className="flex items-center gap-1 px-2 py-0.5 bg-gray-700/50 text-gray-300 rounded-full text-[10px]"
              >
                <Tag size={10} />
                {trope}
              </span>
            ))}
          </div>

          {/* Synopsis */}
          <p className="text-gray-400 text-xs leading-relaxed mt-3 max-w-xl">
            {book.synopsis.length > 300 ? book.synopsis.slice(0, 300) + '...' : book.synopsis}
          </p>
        </div>
      </div>

      {/* Scores & Colors side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Trend Scores */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
          <h2 className="text-white font-semibold text-sm mb-4">Trend Score: {book.total_score}/15</h2>
          <TrendBar label="Social Momentum" score={book.social_momentum} rationale={book.social_momentum_rationale} />
          <TrendBar label="Design Novelty" score={book.design_novelty} rationale={book.design_novelty_rationale} />
          <TrendBar label="Audience Size" score={book.audience_size} rationale={book.audience_size_rationale} />
        </div>

        {/* Visual Profile */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
          <h2 className="text-white font-semibold text-sm mb-4">Visual Profile</h2>

          <div className="mb-4">
            <p className="text-gray-400 text-xs mb-1.5">Cover Color Palette</p>
            <ColorSwatch colors={book.color_palette} size="lg" />
          </div>

          <div className="mb-4">
            <p className="text-gray-400 text-xs mb-1.5">Visual Keywords</p>
            <div className="flex flex-wrap gap-1.5">
              {book.visual_keywords.map((kw, i) => (
                <span key={i} className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded-full text-[10px]">
                  {kw}
                </span>
              ))}
            </div>
          </div>

          <div>
            <p className="text-gray-400 text-xs mb-1.5">Character Archetypes</p>
            <div className="flex flex-wrap gap-1.5">
              {book.character_archetypes.map((arch, i) => (
                <span key={i} className="px-2 py-0.5 bg-pink-500/20 text-pink-300 rounded-full text-[10px]">
                  {arch}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Design Concepts — side by side */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Design Concepts</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {book.concepts.map((concept) => (
            <ConceptCard key={concept.id} concept={concept} onFavoriteChange={fetchBook} />
          ))}
        </div>
      </div>
    </div>
  );
}
