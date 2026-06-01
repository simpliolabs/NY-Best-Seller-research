import { useState } from "react";

interface ImageThumbnailProps {
  src: string | null | undefined;
  alt: string;
  size?: number;
  className?: string;
  onClick?: () => void;
  badge?: string;
}

export function ImageThumbnail({ src, alt, size = 120, className = "", onClick, badge }: ImageThumbnailProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (!src || error) {
    return (
      <div
        className={`relative flex items-center justify-center bg-muted rounded-lg overflow-hidden ${className}`}
        style={{ width: size, height: size, minWidth: size }}
      >
        <svg className="w-8 h-8 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        {badge && (
          <span className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-bold bg-amber-500 text-white rounded-full">
            {badge}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative rounded-lg overflow-hidden cursor-pointer group ${className}`}
      style={{ width: size, height: size, minWidth: size }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
    >
      {!loaded && (
        <div className="absolute inset-0 bg-muted animate-pulse" />
      )}
      <img
        src={src}
        alt={alt}
        className={`w-full h-full object-cover transition-transform duration-200 group-hover:scale-110 ${loaded ? "opacity-100" : "opacity-0"}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {badge && (
        <span className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-bold bg-amber-500 text-white rounded-full shadow-sm">
          {badge}
        </span>
      )}
      {onClick && (
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <svg className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
          </svg>
        </div>
      )}
    </div>
  );
}
