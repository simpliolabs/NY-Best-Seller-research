/**
 * Product Groups admin page — Phase C
 * Allows creating product groups, uploading blank mockup photos,
 * setting color/size metadata, configuring per-size pricing tiers,
 * and visually defining the print zone per group.
 */
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Plus, Upload, Trash2, ChevronDown, ChevronUp, Package, Target } from "lucide-react";
import { toast } from "sonner";
import { PrintZoneEditor, type PrintZoneCoords } from "@/components/PrintZoneEditor";

const ALL_SIZES = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

// ─── Create Group Dialog ───────────────────────────────────────────────────────
function CreateGroupDialog({ workspaceId, onCreated }: { workspaceId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [productType, setProductType] = useState("T-Shirt");
  const [compareAtPrice, setCompareAtPrice] = useState("");
  const createMutation = trpc.productGroup.create.useMutation({
    onSuccess: () => {
      toast.success("Product group created");
      setOpen(false);
      setName(""); setSlug(""); setDescription(""); setProductType("T-Shirt"); setCompareAtPrice("");
      onCreated();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleNameChange = (v: string) => {
    setName(v);
    setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-green-600 hover:bg-green-700 text-white">
          <Plus className="w-4 h-4" /> New Product Group
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-['Syne'] text-lg">Create Product Group</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1">
            <Label>Group Name</Label>
            <Input placeholder="Comfort Colors 1717" value={name} onChange={e => handleNameChange(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Slug</Label>
            <Input placeholder="comfort-colors-1717" value={slug} onChange={e => setSlug(e.target.value)} />
            <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only</p>
          </div>
          <div className="space-y-1">
            <Label>Description (optional)</Label>
            <Textarea placeholder="Garment-dyed heavyweight cotton tee" value={description} onChange={e => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-1">
            <Label>Product Type</Label>
            <Input placeholder="T-Shirt" value={productType} onChange={e => setProductType(e.target.value)} />
            <p className="text-xs text-muted-foreground">Used in listing titles, e.g. "Master the Drop T-Shirt"</p>
          </div>
          <div className="space-y-1">
            <Label>Compare-At Price ($)</Label>
            <Input type="number" step="0.01" placeholder="49.95" value={compareAtPrice} onChange={e => setCompareAtPrice(e.target.value)} />
            <p className="text-xs text-muted-foreground">The strikethrough price shown to customers</p>
          </div>
          <Button
            className="w-full bg-green-600 hover:bg-green-700 text-white"
            disabled={!name || !slug || createMutation.isPending}
            onClick={() => createMutation.mutate({
              workspaceId,
              name,
              slug,
              description: description || undefined,
              productType: productType || "T-Shirt",
              compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : undefined,
            })}
          >
            {createMutation.isPending ? "Creating…" : "Create Group"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pricing Tiers Editor ──────────────────────────────────────────────────────
function PricingTiersEditor({ groupId, initialTiers }: { groupId: string; initialTiers: Array<{ sizes: string[]; price: number }> | null }) {
  const [tiers, setTiers] = useState<Array<{ sizes: string[]; price: number }>>(
    initialTiers ?? [{ sizes: ["S", "M", "L", "XL"], price: 34.95 }]
  );
  const utils = trpc.useUtils();

  const updateMutation = trpc.productGroup.update.useMutation({
    onSuccess: () => { toast.success("Pricing saved"); utils.productGroup.get.invalidate({ groupId }); },
    onError: (err) => toast.error(err.message),
  });

  const addTier = () => setTiers(prev => [...prev, { sizes: [], price: 0 }]);
  const removeTier = (i: number) => setTiers(prev => prev.filter((_, idx) => idx !== i));
  const toggleSize = (tierIdx: number, size: string) => {
    setTiers(prev => prev.map((t, i) => i === tierIdx
      ? { ...t, sizes: t.sizes.includes(size) ? t.sizes.filter(s => s !== size) : [...t.sizes, size] }
      : t
    ));
  };
  const setPrice = (tierIdx: number, price: string) => {
    setTiers(prev => prev.map((t, i) => i === tierIdx ? { ...t, price: parseFloat(price) || 0 } : t));
  };

  return (
    <div className="space-y-3">
      {tiers.map((tier, i) => (
        <div key={i} className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium font-['Manrope']">Tier {i + 1}</span>
            {tiers.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => removeTier(i)} className="h-6 w-6 p-0 text-destructive">
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {ALL_SIZES.map(size => (
              <button
                key={size}
                onClick={() => toggleSize(i, size)}
                className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                  tier.sizes.includes(size)
                    ? "bg-green-600 text-white border-green-600"
                    : "bg-transparent text-muted-foreground border-border hover:border-green-400"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs whitespace-nowrap">Sale Price ($)</Label>
            <Input
              type="number" step="0.01" className="h-7 text-sm"
              value={tier.price || ""}
              onChange={e => setPrice(i, e.target.value)}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={addTier} className="gap-1 text-xs">
          <Plus className="w-3 h-3" /> Add Tier
        </Button>
        <Button
          size="sm"
          className="bg-green-600 hover:bg-green-700 text-white text-xs"
          disabled={updateMutation.isPending}
          onClick={() => updateMutation.mutate({ groupId, pricingTiers: tiers })}
        >
          {updateMutation.isPending ? "Saving…" : "Save Pricing"}
        </Button>
      </div>
    </div>
  );
}

// ─── Mockup Upload Card ────────────────────────────────────────────────────────
function MockupUploadCard({ groupId, onUploaded }: { groupId: string; onUploaded: () => void }) {
  const [colorName, setColorName] = useState("");
  const [colorHex, setColorHex] = useState("#000000");
  const [sizes, setSizes] = useState<string[]>(["S", "M", "L", "XL"]);
  const [preview, setPreview] = useState<string | null>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<"image/jpeg" | "image/png" | "image/webp">("image/jpeg");
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const uploadMutation = trpc.productGroup.uploadMockup.useMutation({
    onSuccess: () => {
      toast.success("Mockup uploaded");
      setColorName(""); setColorHex("#000000"); setSizes(["S", "M", "L", "XL"]);
      setPreview(null); setBase64(null);
      utils.productGroup.get.invalidate({ groupId });
      onUploaded();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleFile = (file: File) => {
    const mime = file.type as "image/jpeg" | "image/png" | "image/webp";
    setMimeType(mime);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setPreview(dataUrl);
      // Strip the data URL prefix to get pure base64
      setBase64(dataUrl.split(",")[1]);
    };
    reader.readAsDataURL(file);
  };

  const toggleSize = (size: string) =>
    setSizes(prev => prev.includes(size) ? prev.filter(s => s !== size) : [...prev, size]);

  return (
    <div className="border-2 border-dashed border-border rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium font-['Syne']">Upload New Mockup</p>

      {/* Drop zone */}
      <div
        className="flex flex-col items-center justify-center h-32 rounded-md bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors"
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      >
        {preview ? (
          <img src={preview} alt="preview" className="h-full object-contain rounded" />
        ) : (
          <>
            <Upload className="w-6 h-6 text-muted-foreground mb-1" />
            <p className="text-xs text-muted-foreground">Click or drag PNG/JPG here</p>
          </>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

      {/* Color metadata */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Color Name</Label>
          <Input className="h-8 text-sm" placeholder="Butter" value={colorName} onChange={e => setColorName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Color Hex</Label>
          <div className="flex gap-1">
            <input type="color" value={colorHex} onChange={e => setColorHex(e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0 p-0" />
            <Input className="h-8 text-sm" value={colorHex} onChange={e => setColorHex(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Available sizes */}
      <div className="space-y-1">
        <Label className="text-xs">Available Sizes</Label>
        <div className="flex flex-wrap gap-1">
          {ALL_SIZES.map(size => (
            <button key={size} onClick={() => toggleSize(size)}
              className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                sizes.includes(size)
                  ? "bg-green-600 text-white border-green-600"
                  : "bg-transparent text-muted-foreground border-border hover:border-green-400"
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      </div>

      <Button
        className="w-full bg-green-600 hover:bg-green-700 text-white text-sm"
        disabled={!base64 || !colorName || sizes.length === 0 || uploadMutation.isPending}
        onClick={() => {
          if (!base64) return;
          uploadMutation.mutate({ groupId, colorName, colorHex, availableSizes: sizes, imageBase64: base64, mimeType, sortOrder: 0 });
        }}
      >
        {uploadMutation.isPending ? "Uploading…" : "Upload Mockup"}
      </Button>
    </div>
  );
}

// ─── Coordinate helpers ────────────────────────────────────────────────────────
/** Convert garment-relative zone to photo-relative for display in the editor.
 * Inverse of the server-side photo→garment conversion in productGroupRouter.ts. */
function garmentToPhoto(
  zone: PrintZoneCoords,
  bbox: { x: number; y: number; width: number; height: number }
): PrintZoneCoords {
  return {
    x: bbox.x + zone.x * bbox.width,
    y: bbox.y + zone.y * bbox.height,
    width: zone.width * bbox.width,
    height: zone.height * bbox.height,
  };
}

// ─── Print Zone Section ─────────────────────────────────────────────────────────────────────────
function PrintZoneSection({ groupId, currentZone, firstMockupUrl, firstTemplateId, firstGarmentBbox }: {
  groupId: string;
  currentZone: PrintZoneCoords | null;
  firstMockupUrl: string | null;
  firstTemplateId: string | null;
  firstGarmentBbox: { x: number; y: number; width: number; height: number } | null;
}) {
  const [editing, setEditing] = useState(false);
  const utils = trpc.useUtils();

  const updateMutation = trpc.productGroup.update.useMutation({
    onSuccess: () => {
      toast.success("Print zone saved");
      setEditing(false);
      utils.productGroup.get.invalidate({ groupId });
    },
    onError: (err) => toast.error(`Failed to save: ${err.message}`),
  });

  if (!firstMockupUrl) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Upload at least one mockup photo to define the print zone.
      </div>
    );
  }

  // Convert stored garment-relative zone → photo-relative for display.
  // The DB stores garment-relative fractions (portable across templates).
  // The editor works in photo-relative fractions (what the user sees on screen).
  // Without this conversion, the editor shows the wrong rectangle and every save
  // compounds the error (photo-relative → garment-relative → wrong display → save again).
  const displayZone: PrintZoneCoords | null =
    currentZone && firstGarmentBbox
      ? garmentToPhoto(currentZone, firstGarmentBbox)
      : currentZone; // fallback: no bbox cached yet, show raw (legacy behavior)

  if (!editing) {
    return (
      <div className="flex items-center justify-between">
        <div className="text-sm">
          {displayZone ? (
            <span className="font-mono text-xs text-muted-foreground">
              {Math.round(displayZone.width * 100)}% × {Math.round(displayZone.height * 100)}% at ({Math.round(displayZone.x * 100)}%, {Math.round(displayZone.y * 100)}%)
            </span>
          ) : (
            <span className="text-xs text-amber-600">Using default zone — click Edit to customize</span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5 text-xs">
          <Target className="w-3 h-3" />
          {displayZone ? "Edit Zone" : "Set Zone"}
        </Button>
      </div>
    );
  }

  return (
    <PrintZoneEditor
      imageUrl={firstMockupUrl}
      initialZone={displayZone}
      onSave={(zone) => updateMutation.mutate({ groupId, printZone: zone, referenceTemplateId: firstTemplateId ?? undefined })}
      onCancel={() => setEditing(false)}
      saving={updateMutation.isPending}
    />
  );
}

// ─── Product Group Card ────────────────────────────────────────────────────────
function ProductGroupCard({ groupId }: { groupId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.productGroup.get.useQuery({ groupId });
  const deleteMockupMutation = trpc.productGroup.deleteMockup.useMutation({
    onSuccess: () => { toast.success("Mockup removed"); utils.productGroup.get.invalidate({ groupId }); },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading || !data) return <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />;

  const firstMockup = data.mockups.length > 0 ? data.mockups[0] : null;
  const firstMockupUrl = firstMockup?.imageUrl ?? null;
  const currentZone = data.printZone as PrintZoneCoords | null;
  // garmentBbox is needed so PrintZoneSection can convert garment-relative → photo-relative for display
  const firstGarmentBbox = (firstMockup?.garmentBbox as { x: number; y: number; width: number; height: number } | null) ?? null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="font-['Syne'] text-base">{data.name}</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {data.mockups.length} mockup{data.mockups.length !== 1 ? "s" : ""} ·{" "}
              {data.compareAtPrice ? `Compare at $${data.compareAtPrice}` : "No compare-at price set"}
              {currentZone && (
                <> · <span className="text-green-600">Print zone set</span></>
              )}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(e => !e)} className="h-7 w-7 p-0">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-4">
          {/* Print Zone Editor */}
          <div>
            <p className="text-xs font-medium font-['Syne'] text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Target className="w-3 h-3" />
              Print Zone
            </p>
            <PrintZoneSection
              groupId={groupId}
              currentZone={currentZone}
              firstMockupUrl={firstMockupUrl}
              firstTemplateId={firstMockup?.id ?? null}
              firstGarmentBbox={firstGarmentBbox}
            />
          </div>

          <Separator />

          {/* Mockup grid */}
          {data.mockups.length > 0 && (
            <div>
              <p className="text-xs font-medium font-['Syne'] text-muted-foreground uppercase tracking-wide mb-2">Mockups</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {data.mockups.map(m => (
                  <div key={m.id} className="relative group rounded-lg overflow-hidden border bg-muted/20">
                    <img src={m.imageUrl} alt={m.colorName} className="w-full aspect-square object-cover" />
                    <div className="p-2">
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-full border border-border flex-shrink-0" style={{ backgroundColor: m.colorHex }} />
                        <span className="text-xs font-medium font-['Manrope'] truncate">{m.colorName}</span>
                      </div>
                      <div className="flex flex-wrap gap-0.5 mt-1">
                        {(m.availableSizes as string[]).map(s => (
                          <Badge key={s} variant="secondary" className="text-[10px] px-1 py-0 h-4">{s}</Badge>
                        ))}
                      </div>
                    </div>
                    <button
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-destructive text-destructive-foreground rounded p-0.5"
                      onClick={() => deleteMockupMutation.mutate({ mockupId: m.id })}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upload new mockup */}
          {showUpload ? (
            <MockupUploadCard groupId={groupId} onUploaded={() => setShowUpload(false)} />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowUpload(true)} className="gap-1.5 text-xs">
              <Upload className="w-3 h-3" /> Add Mockup Photo
            </Button>
          )}

          <Separator />

          {/* Pricing tiers */}
          <div>
            <p className="text-xs font-medium font-['Syne'] text-muted-foreground uppercase tracking-wide mb-2">Pricing Tiers</p>
            <PricingTiersEditor groupId={groupId} initialTiers={data.pricingTiers as Array<{ sizes: string[]; price: number }> | null} />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function ProductGroups() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id ?? "";

  const { data: groups, isLoading, refetch } = trpc.productGroup.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  if (!workspaceId) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
        <Package className="w-10 h-10 opacity-30" />
        <p className="text-sm">Select a workspace to manage product groups.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-['Syne'] tracking-tight">Product Groups</h1>
          <p className="text-sm text-muted-foreground mt-1 font-['Manrope']">
            Upload blank mockup photos, set color metadata, configure pricing, and define print zones.
          </p>
        </div>
        <CreateGroupDialog workspaceId={workspaceId} onCreated={() => refetch()} />
      </div>

      {/* Groups list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-20 bg-muted/30 rounded-lg animate-pulse" />)}
        </div>
      ) : !groups || groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 border-2 border-dashed rounded-xl text-muted-foreground gap-3">
          <Package className="w-10 h-10 opacity-30" />
          <p className="text-sm font-['Manrope']">No product groups yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => <ProductGroupCard key={g.id} groupId={g.id} />)}
        </div>
      )}
    </div>
  );
}
