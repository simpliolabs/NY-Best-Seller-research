/**
 * PrintZoneEditor — Visual canvas overlay for defining the print zone on a mockup template.
 * User draws/resizes a rectangle on the shirt image to define where designs will be placed.
 * Outputs normalized coordinates (0-1 range) relative to image dimensions.
 *
 * Karpathy: One component, no class hierarchy, minimal state.
 */
import { useRef, useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Save, RotateCcw, Move } from "lucide-react";

export interface PrintZoneCoords {
  x: number; // left edge, 0-1
  y: number; // top edge, 0-1
  width: number; // 0-1
  height: number; // 0-1
}

interface PrintZoneEditorProps {
  /** URL of the mockup template image to draw on */
  imageUrl: string;
  /** Current saved print zone (if any) */
  initialZone?: PrintZoneCoords | null;
  /** Called when user saves the drawn zone */
  onSave: (zone: PrintZoneCoords) => void;
  /** Called when user cancels */
  onCancel?: () => void;
  /** Whether save is in progress */
  saving?: boolean;
}

type DragMode = "none" | "draw" | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br";

const DEFAULT_ZONE: PrintZoneCoords = { x: 0.22, y: 0.15, width: 0.56, height: 0.6 };
const MIN_SIZE = 0.05; // minimum 5% of image dimension

export function PrintZoneEditor({
  imageUrl,
  initialZone,
  onSave,
  onCancel,
  saving = false,
}: PrintZoneEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [zone, setZone] = useState<PrintZoneCoords>(initialZone ?? DEFAULT_ZONE);
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [zoneAtDragStart, setZoneAtDragStart] = useState<PrintZoneCoords>(zone);

  // Reset zone when initialZone changes
  useEffect(() => {
    if (initialZone) {
      setZone(initialZone);
    }
  }, [initialZone]);

  const handleImageLoad = useCallback(() => {
    setImageLoaded(true);
  }, []);

  // Convert pixel position to normalized coordinates relative to image
  const pixelToNorm = useCallback(
    (px: number, py: number) => {
      if (!containerRef.current) return { nx: 0, ny: 0 };
      const rect = containerRef.current.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (px - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (py - rect.top) / rect.height));
      return { nx, ny };
    },
    []
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!imageLoaded) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      const { nx, ny } = pixelToNorm(e.clientX, e.clientY);
      setDragStart({ x: nx, y: ny });
      setZoneAtDragStart(zone);

      // Determine what we're clicking on
      const handleSize = 0.025; // 2.5% of image for handle hit area

      // Check corner handles
      if (
        Math.abs(nx - zone.x) < handleSize &&
        Math.abs(ny - zone.y) < handleSize
      ) {
        setDragMode("resize-tl");
      } else if (
        Math.abs(nx - (zone.x + zone.width)) < handleSize &&
        Math.abs(ny - zone.y) < handleSize
      ) {
        setDragMode("resize-tr");
      } else if (
        Math.abs(nx - zone.x) < handleSize &&
        Math.abs(ny - (zone.y + zone.height)) < handleSize
      ) {
        setDragMode("resize-bl");
      } else if (
        Math.abs(nx - (zone.x + zone.width)) < handleSize &&
        Math.abs(ny - (zone.y + zone.height)) < handleSize
      ) {
        setDragMode("resize-br");
      } else if (
        nx >= zone.x &&
        nx <= zone.x + zone.width &&
        ny >= zone.y &&
        ny <= zone.y + zone.height
      ) {
        // Inside the zone — move
        setDragMode("move");
      } else {
        // Outside — draw new zone
        setDragMode("draw");
        setZone({ x: nx, y: ny, width: 0, height: 0 });
      }
    },
    [imageLoaded, pixelToNorm, zone]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragMode === "none") return;
      e.preventDefault();

      const { nx, ny } = pixelToNorm(e.clientX, e.clientY);
      const dx = nx - dragStart.x;
      const dy = ny - dragStart.y;

      if (dragMode === "draw") {
        // Draw from dragStart to current position
        const x = Math.min(dragStart.x, nx);
        const y = Math.min(dragStart.y, ny);
        const w = Math.abs(nx - dragStart.x);
        const h = Math.abs(ny - dragStart.y);
        setZone({ x, y, width: w, height: h });
      } else if (dragMode === "move") {
        let newX = zoneAtDragStart.x + dx;
        let newY = zoneAtDragStart.y + dy;
        // Clamp to image bounds
        newX = Math.max(0, Math.min(1 - zoneAtDragStart.width, newX));
        newY = Math.max(0, Math.min(1 - zoneAtDragStart.height, newY));
        setZone({ ...zoneAtDragStart, x: newX, y: newY });
      } else if (dragMode === "resize-tl") {
        const right = zoneAtDragStart.x + zoneAtDragStart.width;
        const bottom = zoneAtDragStart.y + zoneAtDragStart.height;
        const newX = Math.max(0, Math.min(right - MIN_SIZE, nx));
        const newY = Math.max(0, Math.min(bottom - MIN_SIZE, ny));
        setZone({ x: newX, y: newY, width: right - newX, height: bottom - newY });
      } else if (dragMode === "resize-tr") {
        const left = zoneAtDragStart.x;
        const bottom = zoneAtDragStart.y + zoneAtDragStart.height;
        const newRight = Math.min(1, Math.max(left + MIN_SIZE, nx));
        const newY = Math.max(0, Math.min(bottom - MIN_SIZE, ny));
        setZone({ x: left, y: newY, width: newRight - left, height: bottom - newY });
      } else if (dragMode === "resize-bl") {
        const right = zoneAtDragStart.x + zoneAtDragStart.width;
        const top = zoneAtDragStart.y;
        const newX = Math.max(0, Math.min(right - MIN_SIZE, nx));
        const newBottom = Math.min(1, Math.max(top + MIN_SIZE, ny));
        setZone({ x: newX, y: top, width: right - newX, height: newBottom - top });
      } else if (dragMode === "resize-br") {
        const left = zoneAtDragStart.x;
        const top = zoneAtDragStart.y;
        const newRight = Math.min(1, Math.max(left + MIN_SIZE, nx));
        const newBottom = Math.min(1, Math.max(top + MIN_SIZE, ny));
        setZone({ x: left, y: top, width: newRight - left, height: newBottom - top });
      }
    },
    [dragMode, dragStart, zoneAtDragStart, pixelToNorm]
  );

  const handlePointerUp = useCallback(() => {
    setDragMode("none");
  }, []);

  const handleReset = useCallback(() => {
    setZone(initialZone ?? DEFAULT_ZONE);
  }, [initialZone]);

  const handleSave = useCallback(() => {
    // Ensure minimum size
    if (zone.width < MIN_SIZE || zone.height < MIN_SIZE) {
      return;
    }
    onSave({
      x: Math.round(zone.x * 1000) / 1000,
      y: Math.round(zone.y * 1000) / 1000,
      width: Math.round(zone.width * 1000) / 1000,
      height: Math.round(zone.height * 1000) / 1000,
    });
  }, [zone, onSave]);

  // Zone pixel positions for overlay
  const zoneStyle = imageLoaded
    ? {
        left: `${zone.x * 100}%`,
        top: `${zone.y * 100}%`,
        width: `${zone.width * 100}%`,
        height: `${zone.height * 100}%`,
      }
    : { display: "none" as const };

  return (
    <div className="space-y-4">
      {/* Instructions */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
        <Move className="h-4 w-4 shrink-0" />
        <span>
          Drag the rectangle to position the print zone. Drag corners to resize.
          Click outside the zone to draw a new one.
        </span>
      </div>

      {/* Canvas area — container is locked to the image's natural aspect ratio so there are zero letterbox bars.
           Every pixel of the container IS a pixel of the image. No offset math needed. */}
      <div
        ref={containerRef}
        className="relative select-none rounded-lg overflow-hidden border bg-muted/20 cursor-crosshair w-full"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          touchAction: "none",
        }}
      >
        <img
          src={imageUrl}
          alt="Mockup template"
          className="w-full h-auto block"
          onLoad={handleImageLoad}
          draggable={false}
        />

        {/* Semi-transparent overlay outside the zone */}
        {imageLoaded && (
          <div className="absolute inset-0 pointer-events-none">
            {/* Dark overlay with cutout */}
            <div
              className="absolute inset-0 bg-black/40"
              style={{
                clipPath: `polygon(
                  0% 0%, 100% 0%, 100% 100%, 0% 100%,
                  0% ${zone.y * 100}%,
                  ${zone.x * 100}% ${zone.y * 100}%,
                  ${zone.x * 100}% ${(zone.y + zone.height) * 100}%,
                  ${(zone.x + zone.width) * 100}% ${(zone.y + zone.height) * 100}%,
                  ${(zone.x + zone.width) * 100}% ${zone.y * 100}%,
                  0% ${zone.y * 100}%
                )`,
              }}
            />

            {/* Zone border */}
            <div
              className="absolute border-2 border-dashed border-blue-400"
              style={zoneStyle}
            >
              {/* Corner handles */}
              <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-blue-500 rounded-full border border-white shadow cursor-nw-resize" />
              <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-blue-500 rounded-full border border-white shadow cursor-ne-resize" />
              <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-blue-500 rounded-full border border-white shadow cursor-sw-resize" />
              <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-blue-500 rounded-full border border-white shadow cursor-se-resize" />

              {/* Center label */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="bg-blue-500/80 text-white text-xs px-2 py-0.5 rounded font-mono">
                  {Math.round(zone.width * 100)}% × {Math.round(zone.height * 100)}%
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Coordinates readout */}
      <div className="grid grid-cols-4 gap-2 text-xs font-mono text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
        <div>X: {(zone.x * 100).toFixed(1)}%</div>
        <div>Y: {(zone.y * 100).toFixed(1)}%</div>
        <div className={zone.width < 0.40 ? "text-amber-500 font-bold" : ""}>W: {(zone.width * 100).toFixed(1)}%{zone.width < 0.40 ? " ⚠" : ""}</div>
        <div>H: {(zone.height * 100).toFixed(1)}%</div>
      </div>
      {zone.width < 0.40 && (
        <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ⚠ Zone width is {Math.round(zone.width * 100)}% — recommended minimum is 40%. A narrow zone will make designs appear small on the shirt. Aim for 50–60% width to fill the chest area.
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || zone.width < MIN_SIZE || zone.height < MIN_SIZE}>
          {saving ? (
            <>
              <span className="animate-spin mr-2">⏳</span>
              Saving…
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save Print Zone
            </>
          )}
        </Button>
        <Button variant="outline" onClick={handleReset}>
          <RotateCcw className="h-4 w-4 mr-2" />
          Reset
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
