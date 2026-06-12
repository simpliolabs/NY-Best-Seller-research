/**
 * Listings Page — Phase I
 * Create and manage Shopify listing drafts from mockup renders.
 * Flow: select concept → pick mockups → generate copy → mark ready.
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Store,
  Plus,
  Trash2,
  Sparkles,
  CheckCircle2,
  Loader2,
  Image as ImageIcon,
  Tag,
  DollarSign,
  Upload,
  ExternalLink,
} from "lucide-react";

export default function Listings() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id ?? "";
  const utils = trpc.useUtils();

  // ─── Create form state ─────────────────────────────────────────────
  const [selectedConceptId, setSelectedConceptId] = useState<string>("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [selectedMockups, setSelectedMockups] = useState<string[]>([]);
  const [customTitle, setCustomTitle] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // ─── Queries ───────────────────────────────────────────────────────
  const listingsQuery = trpc.listing.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  // winnersOnly:false — Niche-Hunter concepts are all created isWinner:false (db.ts createConceptFromPattern),
  // so winnersOnly:true filtered the listings dropdown to EMPTY. Any concept with a design image is listable.
  const conceptsQuery = trpc.library.list.useQuery(
    { limit: 100, offset: 0, winnersOnly: false, workspaceId },
    { enabled: !!workspaceId && showCreateForm }
  );

  const groupsQuery = trpc.productGroup.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  const mockupsQuery = trpc.mockup.getMockups.useQuery(
    { conceptId: Number(selectedConceptId) },
    { enabled: !!selectedConceptId }
  );

  // ─── Mutations ─────────────────────────────────────────────────────
  const createMutation = trpc.listing.create.useMutation({
    onSuccess: () => {
      toast.success("Listing draft created");
      utils.listing.list.invalidate({ workspaceId });
      resetForm();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.listing.delete.useMutation({
    onSuccess: () => {
      toast.success("Listing deleted");
      utils.listing.list.invalidate({ workspaceId });
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.listing.update.useMutation({
    onSuccess: () => {
      utils.listing.list.invalidate({ workspaceId });
    },
    onError: (err) => toast.error(err.message),
  });

  const generateDescMutation = trpc.listing.generateDescription.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const publishMutation = trpc.listing.publishToShopify.useMutation({
    onSuccess: (data) => {
      toast.success(
        <span>
          Published to Shopify!{" "}
          <a
            href={data.shopifyAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            View product →
          </a>
        </span>
      );
      utils.listing.list.invalidate({ workspaceId });
    },
    onError: (err) => toast.error(err.message),
  });

  const shopifyStatus = trpc.workspace.shopifyStatus.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );
  const isShopifyConnected = shopifyStatus.data?.connected ?? false;

  // ─── Helpers ───────────────────────────────────────────────────────
  const conceptsWithImages = useMemo(() => {
    if (!conceptsQuery.data?.concepts) return [];
    return conceptsQuery.data.concepts.filter(
      (c) => c.imageUrlA || c.imageUrlB || c.imageUrlC
    );
  }, [conceptsQuery.data]);

  function resetForm() {
    setSelectedConceptId("");
    setSelectedGroupId("");
    setSelectedMockups([]);
    setCustomTitle("");
    setCustomPrice("");
    setShowCreateForm(false);
  }

  function toggleMockup(id: string) {
    setSelectedMockups((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  function handleCreate() {
    if (!selectedConceptId || !selectedGroupId || selectedMockups.length === 0) return;
    createMutation.mutate({
      workspaceId,
      conceptId: Number(selectedConceptId),
      productGroupId: selectedGroupId,
      mockupRenderIds: selectedMockups,
      title: customTitle || undefined,
      price: customPrice ? Number(customPrice) : undefined,
    });
  }

  async function handleGenerateDescription(listingId: string, conceptId: number, title: string, groupName: string, productType?: string) {
    const result = await generateDescMutation.mutateAsync({
      conceptId,
      title,
      productGroupName: groupName,
      productType: productType ?? groupName,
    });
    // Strip any residual HTML tags the LLM might still include
    const plainDescription = result.description.replace(/<[^>]*>/g, "").trim();
    await updateMutation.mutateAsync({
      id: listingId,
      description: plainDescription,
      tags: result.tags,
    });
    toast.success("Description & tags generated");
  }

  async function markReady(listingId: string) {
    await updateMutation.mutateAsync({ id: listingId, status: "ready" });
    toast.success("Listing marked as ready");
  }

  const listings = listingsQuery.data ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-['Syne'] tracking-tight">Listings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Create Shopify listing drafts from your mockups — generate copy, set pricing, and export.
          </p>
        </div>
        <Button onClick={() => setShowCreateForm(true)} disabled={showCreateForm}>
          <Plus className="h-4 w-4 mr-2" />
          New Listing
        </Button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-['Syne'] flex items-center gap-2">
              <Store className="h-4 w-4" />
              Create Listing Draft
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Concept */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Concept
                </label>
                <Select value={selectedConceptId} onValueChange={(v) => { setSelectedConceptId(v); setSelectedMockups([]); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select concept…" />
                  </SelectTrigger>
                  <SelectContent>
                    {conceptsWithImages.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.conceptName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Product Group */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Product Group
                </label>
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select group…" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupsQuery.data?.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Custom Title */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Title (optional)
                </label>
                <Input
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Auto from concept name"
                />
              </div>
            </div>

            {/* Price */}
            <div className="max-w-[200px] space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Price (optional)
              </label>
              <Input
                type="number"
                step="0.01"
                value={customPrice}
                onChange={(e) => setCustomPrice(e.target.value)}
                placeholder="Auto from group"
              />
            </div>

            {/* Mockup Selection */}
            {selectedConceptId && mockupsQuery.data && mockupsQuery.data.length > 0 && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Select Mockup Images ({selectedMockups.length} selected)
                </label>
                <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2">
                  {mockupsQuery.data.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => toggleMockup(m.id)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                        selectedMockups.includes(m.id)
                          ? "border-primary ring-2 ring-primary/20"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      <img
                        src={m.compositeUrl}
                        alt={`Mockup ${m.variationKey}`}
                        className="w-full aspect-square object-contain bg-muted/30"
                      />
                      {selectedMockups.includes(m.id) && (
                        <div className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full p-0.5">
                          <CheckCircle2 className="h-3 w-3" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedConceptId && mockupsQuery.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No mockups found for this concept. Generate mockups first.
              </p>
            )}

            {/* Validation hint */}
            {(!selectedConceptId || !selectedGroupId || selectedMockups.length === 0) && !createMutation.isPending && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {!selectedConceptId ? "⚠️ Select a concept to continue." :
                 !selectedGroupId ? "⚠️ Select a product group to continue." :
                 "⚠️ Select at least one mockup image."}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={handleCreate}
                disabled={!selectedConceptId || !selectedGroupId || selectedMockups.length === 0 || createMutation.isPending}
                className="disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {createMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Creating…</>
                ) : (
                  <><Plus className="h-4 w-4 mr-2" /> Create Draft</>
                )}
              </Button>
              <Button variant="outline" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Listings Grid */}
      {listings.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              onDelete={() => {
                if (confirm(`Delete listing "${listing.title}"?`)) {
                  deleteMutation.mutate({ id: listing.id });
                }
              }}
              onGenerateDescription={() => {
                const group = groupsQuery.data?.find((g) => g.id === listing.productGroupId);
                handleGenerateDescription(listing.id, listing.conceptId, listing.title, group?.name ?? "T-Shirt", (group as any)?.productType ?? "T-Shirt");
              }}
              onSkipDescription={() => markReady(listing.id)}
              onMarkReady={() => markReady(listing.id)}
              onPublish={() => publishMutation.mutate({ id: listing.id, workspaceId })}
              isGenerating={generateDescMutation.isPending}
              isPublishing={publishMutation.isPending && publishMutation.variables?.id === listing.id}
              isShopifyConnected={isShopifyConnected}
            />
          ))}
        </div>
      ) : !showCreateForm ? (
        <Card className="p-12 text-center">
          <Store className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold">No Listings Yet</h3>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            Create your first listing draft from a concept with mockups. Generate SEO copy and mark it ready for Shopify export.
          </p>
          <Button className="mt-4" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create First Listing
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Listing Card ──────────────────────────────────────────────────────────

function ListingCard({
  listing,
  onDelete,
  onGenerateDescription,
  onSkipDescription,
  onMarkReady,
  onPublish,
  isGenerating,
  isPublishing,
  isShopifyConnected,
}: {
  listing: any;
  onDelete: () => void;
  onGenerateDescription: () => void;
  onSkipDescription: () => void;
  onMarkReady: () => void;
  onPublish: () => void;
  isGenerating: boolean;
  isPublishing: boolean;
  isShopifyConnected: boolean;
}) {
  const statusColors: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-800 border-yellow-300",
    ready: "bg-green-100 text-green-800 border-green-300",
    exported: "bg-blue-100 text-blue-800 border-blue-300",
  };

  const mockupCount = Array.isArray(listing.mockupRenderIds) ? listing.mockupRenderIds.length : 0;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        {/* Title + status */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm truncate flex-1">{listing.title}</h3>
          <Badge className={`text-[10px] shrink-0 ${statusColors[listing.status] ?? ""}`}>
            {listing.status}
          </Badge>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <DollarSign className="h-3 w-3" />
            {listing.price}
          </span>
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3 w-3" />
            {mockupCount} mockup{mockupCount !== 1 ? "s" : ""}
          </span>
          {listing.tags && listing.tags.length > 0 && (
            <span className="flex items-center gap-1">
              <Tag className="h-3 w-3" />
              {listing.tags.length} tags
            </span>
          )}
        </div>

        {/* Description preview */}
        {listing.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2">{listing.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">No description yet</p>
        )}

        {/* Tags preview */}
        {listing.tags && listing.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {listing.tags.slice(0, 5).map((tag: string, i: number) => (
              <span key={i} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                {tag}
              </span>
            ))}
            {listing.tags.length > 5 && (
              <span className="text-[10px] text-muted-foreground">+{listing.tags.length - 5} more</span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {!listing.description && listing.status === "draft" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onGenerateDescription}
                disabled={isGenerating}
                className="text-xs"
              >
                {isGenerating ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Generate Copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onSkipDescription}
                disabled={isGenerating}
                className="text-xs text-muted-foreground"
              >
                Skip Description
              </Button>
            </>
          )}
          {listing.status === "draft" && listing.description && (
            <Button size="sm" onClick={onMarkReady} className="text-xs">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Mark Ready
            </Button>
          )}
          {listing.status === "ready" && (
            <Button
              size="sm"
              onClick={onPublish}
              disabled={isPublishing || !isShopifyConnected}
              title={!isShopifyConnected ? "Connect your Shopify store in Workspace Settings first" : "Publish to Shopify as draft product"}
              className="text-xs bg-green-600 hover:bg-green-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPublishing ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Upload className="h-3 w-3 mr-1" />
              )}
              Publish to Shopify
            </Button>
          )}
          {listing.status === "exported" && listing.shopifyProductId && (
            <a
              href={`https://admin.shopify.com/store/${listing.shopifyProductId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              View on Shopify
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 ml-auto"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
