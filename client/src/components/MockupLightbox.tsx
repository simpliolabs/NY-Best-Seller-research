/**
 * MockupLightbox — simple fixed-overlay image zoom for mockup composites.
 * Props: src (nullable — renders nothing when null), alt, onClose.
 * Closes on Esc keydown or backdrop click.
 */
import { useEffect } from "react";

interface MockupLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export function MockupLightbox({ src, alt = "Mockup", onClose }: MockupLightboxProps) {
  useEffect(() => {
    if (!src) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
