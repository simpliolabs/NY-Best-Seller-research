import { useEffect, useState } from 'react';
import { Loader2, Heart, Filter } from 'lucide-react';
import { getFavorites } from '../api';
import type { DesignConcept } from '../api';
import ConceptCard from '../components/ConceptCard';

export default function Favorites() {
  const [concepts, setConcepts] = useState<DesignConcept[]>([]);
  const [loading, setLoading] = useState(true);
  const [formatFilter, setFormatFilter] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const [subgenreFilter, setSubgenreFilter] = useState('');

  const fetchFavorites = async () => {
    try {
      setLoading(true);
      const filters: Record<string, string> = {};
      if (formatFilter) filters.format = formatFilter;
      if (styleFilter) filters.style = styleFilter;
      if (subgenreFilter) filters.subgenre = subgenreFilter;
      const data = await getFavorites(filters);
      setConcepts(data);
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFavorites();
  }, [formatFilter, styleFilter, subgenreFilter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Heart size={20} className="text-pink-400" />
        <h1 className="text-2xl font-bold text-white">Saved Concepts</h1>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Filter size={14} className="text-gray-500" />

        <select
          value={formatFilter}
          onChange={(e) => setFormatFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-purple-500"
        >
          <option value="">All Formats</option>
          <option value="t-shirt">T-Shirt</option>
          <option value="hoodie">Hoodie</option>
          <option value="tote bag">Tote Bag</option>
          <option value="sticker">Sticker</option>
          <option value="bookmark">Bookmark</option>
          <option value="mug">Mug</option>
          <option value="sweatshirt">Sweatshirt</option>
        </select>

        <select
          value={styleFilter}
          onChange={(e) => setStyleFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-purple-500"
        >
          <option value="">All Styles</option>
          <option value="line art">Line Art</option>
          <option value="vintage">Vintage</option>
          <option value="minimal">Minimal</option>
          <option value="maximalist">Maximalist</option>
          <option value="gothic">Gothic</option>
          <option value="celestial">Celestial</option>
          <option value="cottagecore">Cottagecore</option>
          <option value="dark academia">Dark Academia</option>
          <option value="retro">Retro</option>
          <option value="watercolor">Watercolor</option>
          <option value="typographic">Typographic</option>
        </select>

        <input
          type="text"
          placeholder="Filter by subgenre..."
          value={subgenreFilter}
          onChange={(e) => setSubgenreFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-purple-500 w-44"
        />

        {(formatFilter || styleFilter || subgenreFilter) && (
          <button
            onClick={() => {
              setFormatFilter('');
              setStyleFilter('');
              setSubgenreFilter('');
            }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="animate-spin text-purple-400" size={32} />
        </div>
      ) : concepts.length === 0 ? (
        <div className="text-center py-20">
          <Heart size={48} className="text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400">No favorited concepts yet.</p>
          <p className="text-gray-500 text-sm mt-1">
            Click the heart icon on any design concept to save it here.
          </p>
        </div>
      ) : (
        <>
          <p className="text-gray-500 text-xs">{concepts.length} saved concept{concepts.length !== 1 ? 's' : ''}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {concepts.map((c) => (
              <div key={c.id}>
                {c.book_title && (
                  <p className="text-[10px] text-gray-500 mb-1 truncate">
                    From: <span className="text-gray-400">{c.book_title}</span> by {c.book_author}
                  </p>
                )}
                <ConceptCard concept={c} onFavoriteChange={fetchFavorites} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
