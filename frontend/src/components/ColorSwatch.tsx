interface ColorSwatchProps {
  colors: string[];
  size?: 'sm' | 'md' | 'lg';
}

const sizeMap = {
  sm: 'w-5 h-5',
  md: 'w-7 h-7',
  lg: 'w-9 h-9',
};

export default function ColorSwatch({ colors, size = 'md' }: ColorSwatchProps) {
  if (!colors || colors.length === 0) return null;

  return (
    <div className="flex gap-1.5 items-center">
      {colors.map((hex, i) => (
        <div
          key={i}
          className={`${sizeMap[size]} rounded-md border border-white/10 shadow-sm cursor-pointer transition-transform hover:scale-110`}
          style={{ backgroundColor: hex }}
          title={hex}
        />
      ))}
    </div>
  );
}
