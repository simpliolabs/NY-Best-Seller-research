import { Heart, AlertTriangle } from 'lucide-react';
import ColorSwatch from './ColorSwatch';
import type { DesignConcept } from '../api';
import { toggleFavorite } from '../api';
import { useState } from 'react';

interface ConceptCardProps {
  concept: DesignConcept;
  onFavoriteChange?: () => void;
}

export default function ConceptCard({ concept, onFavoriteChange }: ConceptCardProps) {
  const [isFav, setIsFav] = useState(concept.is_favorite);
  const [loading, setLoading] = useState(false);

  const handleFavorite = async () => {
    setLoading(true);
    try {
      await toggleFavorite(concept.id, !isFav);
      setIsFav(!isFav);
      onFavoriteChange?.();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 flex flex-col gap-3 relative">
      {/* Copyright Warning */}
      {concept.copyright_flag && (
        <div className="bg-yellow-500/20 border border-yellow-500/40 rounded-lg px-3 py-2 flex items-center gap-2 text-yellow-300 text-xs">
          <AlertTriangle size={14} />
          <span>{concept.copyright_flag_reason || 'Potential copyright concern'}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-start">
        <h4 className="text-white font-semibold text-sm">{concept.concept_name}</h4>
        <button
          onClick={handleFavorite}
          disabled={loading}
          className="p-1 rounded-md hover:bg-gray-700 transition-colors"
        >
          <Heart
            size={18}
            className={isFav ? 'fill-pink-500 text-pink-500' : 'text-gray-500'}
          />
        </button>
      </div>

      {/* Description */}
      <p className="text-gray-400 text-xs leading-relaxed">{concept.description}</p>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full text-[10px] font-medium">
          {concept.style}
        </span>
        <span className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded-full text-[10px] font-medium">
          {concept.format}
        </span>
      </div>

      {/* Design Elements */}
      {(concept.typography || concept.imagery || concept.texture) && (
        <div className="text-[11px] text-gray-500 space-y-0.5">
          {concept.typography && <p><span className="text-gray-400">Typography:</span> {concept.typography}</p>}
          {concept.imagery && <p><span className="text-gray-400">Imagery:</span> {concept.imagery}</p>}
          {concept.texture && <p><span className="text-gray-400">Texture:</span> {concept.texture}</p>}
        </div>
      )}

      {/* Color Palette */}
      <ColorSwatch colors={concept.color_palette} size="sm" />

      {/* Target Audience */}
      <p className="text-[10px] text-gray-600 italic">{concept.target_audience}</p>
    </div>
  );
}
