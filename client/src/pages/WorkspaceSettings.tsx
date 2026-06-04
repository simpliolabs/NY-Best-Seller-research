/**
 * WorkspaceSettings — Phase B fix
 *
 * Allows editing the niche profile (subreddits, keywords, cross-niche categories, etc.)
 * after workspace creation. Available at /workspace-settings.
 */
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Save, X, Plus, Loader2, RefreshCw, Trash2, ShoppingBag, CheckCircle2, Unplug } from "lucide-react";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { NicheProfile } from "@/../../server/onboardingRouter";
import CulturalMapEditor from "@/components/CulturalMapEditor";

export default function WorkspaceSettings() {
  const { activeWorkspace, setActiveWorkspaceId } = useWorkspace();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();

  const { data: workspace, isLoading } = trpc.workspace.get.useQuery(
    { id: activeWorkspace?.id ?? "" },
    { enabled: !!activeWorkspace?.id }
  );

  const [profile, setProfile] = useState<NicheProfile | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [dirty, setDirty] = useState(false);

  // Sync state when workspace data loads
  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setIcon(workspace.icon);
      if (workspace.nicheProfile) {
        setProfile(workspace.nicheProfile as unknown as NicheProfile);
      }
      setDirty(false);
    }
  }, [workspace]);

  const updateMutation = trpc.workspace.update.useMutation({
    onSuccess: () => {
      toast.success("Workspace settings saved");
      utils.workspace.get.invalidate({ id: activeWorkspace?.id ?? "" });
      utils.workspace.list.invalidate();
      setDirty(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const enrichMutation = trpc.onboarding.enrichNiche.useMutation();

  // ─── Shopify state ─────────────────────────────────────────────────────────
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const shopifyStatus = trpc.workspace.shopifyStatus.useQuery(
    { workspaceId: activeWorkspace?.id ?? "" },
    { enabled: !!activeWorkspace?.id }
  );

  const shopifyConnect = trpc.workspace.shopifyConnect.useMutation({
    onSuccess: (data) => {
      toast.success(`Connected to "${data.shopName}"`);
      setShopifyDomain("");
      setShopifyToken("");
      shopifyStatus.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const shopifyDisconnect = trpc.workspace.shopifyDisconnect.useMutation({
    onSuccess: () => {
      toast.success("Shopify store disconnected");
      shopifyStatus.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.workspace.delete.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted");
      setActiveWorkspaceId(null);
      utils.workspace.list.invalidate();
      navigate("/");
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSave() {
    if (!activeWorkspace) return;
    const payload: Record<string, unknown> = { id: activeWorkspace.id, name, icon };
    if (profile) payload.nicheProfile = profile;
    updateMutation.mutate(payload as any);
  }

  async function handleRegenerate() {
    if (!profile) return;
    try {
      const result = await enrichMutation.mutateAsync({
        description: profile.summary + " " + profile.targetAudience,
        workspaceName: name,
      });
      setProfile(result);
      setDirty(true);
      toast.success("Profile regenerated — review and save");
    } catch {
      toast.error("Failed to regenerate profile");
    }
  }

  // Array field helpers
  function updateProfileArray(field: keyof NicheProfile, index: number, value: string) {
    if (!profile) return;
    const arr = [...((profile[field] as string[] | undefined) ?? [])];
    arr[index] = value;
    setProfile({ ...profile, [field]: arr });
    setDirty(true);
  }

  function removeProfileItem(field: keyof NicheProfile, index: number) {
    if (!profile) return;
    const arr = ((profile[field] as string[] | undefined) ?? []).filter((_, i) => i !== index);
    setProfile({ ...profile, [field]: arr });
    setDirty(true);
  }

  function addProfileItem(field: keyof NicheProfile) {
    if (!profile) return;
    setProfile({ ...profile, [field]: [...((profile[field] as string[] | undefined) ?? []), ""] });
    setDirty(true);
  }

  if (isLoading || !workspace) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isNicheHunter = workspace.workspaceType === "niche_hunter";

  const ICONS = ["🎯", "🏓", "🐾", "🌿", "🏔️", "🎸", "🚀", "🎨", "🌊", "🦋", "🏕️", "🎭", "📚"];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}>
            Workspace Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Edit your workspace configuration and niche profile
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={!dirty || updateMutation.isPending}
          style={{ backgroundColor: dirty ? "#22C55E" : undefined }}
          className={dirty ? "text-white hover:opacity-90" : ""}
        >
          {updateMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save Changes
        </Button>
      </div>

      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base" style={{ fontFamily: "Syne, sans-serif" }}>
            Basic Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Workspace Name</label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Icon</label>
            <div className="flex flex-wrap gap-2">
              {ICONS.map((em) => (
                <button
                  key={em}
                  onClick={() => { setIcon(em); setDirty(true); }}
                  className="text-xl w-10 h-10 rounded-lg border flex items-center justify-center transition-colors"
                  style={{
                    borderColor: icon === em ? "#22C55E" : "hsl(var(--border))",
                    backgroundColor: icon === em ? "#22C55E20" : "transparent",
                  }}
                >
                  {em}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Type</label>
            <p className="text-sm text-muted-foreground capitalize">{workspace.workspaceType.replace("_", " ")}</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Slug</label>
            <p className="text-sm text-muted-foreground font-mono">{workspace.slug}</p>
          </div>
        </CardContent>
      </Card>

      {/* Shopify Integration */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2" style={{ fontFamily: "Syne, sans-serif" }}>
              <ShoppingBag className="h-4 w-4" />
              Shopify Integration
            </CardTitle>
            {shopifyStatus.data?.connected && (
              <span className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected to {shopifyStatus.data.storeDomain}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {shopifyStatus.data?.connected ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Your store is connected. Listings marked as <strong>Ready</strong> can be published directly to Shopify as draft products.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => shopifyDisconnect.mutate({ workspaceId: activeWorkspace?.id ?? "" })}
                disabled={shopifyDisconnect.isPending}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
              >
                {shopifyDisconnect.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                ) : (
                  <Unplug className="h-3.5 w-3.5 mr-2" />
                )}
                Disconnect Store
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Connect a Shopify Private App to publish listings directly to your store. You need a <strong>Private App</strong> access token with <em>Products</em> read/write permissions.
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium">Store Domain</label>
                <Input
                  placeholder="your-store.myshopify.com"
                  value={shopifyDomain}
                  onChange={(e) => setShopifyDomain(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Your Shopify myshopify.com subdomain</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Access Token</label>
                <div className="flex gap-2">
                  <Input
                    type={showToken ? "text" : "password"}
                    placeholder="shpat_xxxxxxxxxxxxxxxxxxxx"
                    value={shopifyToken}
                    onChange={(e) => setShopifyToken(e.target.value)}
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="shrink-0"
                  >
                    {showToken ? "Hide" : "Show"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Private App Admin API access token (shpat_*)</p>
              </div>
              <Button
                onClick={() =>
                  shopifyConnect.mutate({
                    workspaceId: activeWorkspace?.id ?? "",
                    storeDomain: shopifyDomain,
                    accessToken: shopifyToken,
                  })
                }
                disabled={!shopifyDomain || !shopifyToken || shopifyConnect.isPending}
                className="disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {shopifyConnect.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Testing connection…</>
                ) : (
                  <><ShoppingBag className="h-4 w-4 mr-2" /> Connect Store</>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Niche Profile (only for niche_hunter workspaces) */}
      {isNicheHunter && profile && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base" style={{ fontFamily: "Syne, sans-serif" }}>
                Niche Profile
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerate}
                disabled={enrichMutation.isPending}
              >
                {enrichMutation.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Regenerate with AI
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Summary */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Summary
              </label>
              <Textarea
                value={profile.summary}
                onChange={(e) => { setProfile({ ...profile, summary: e.target.value }); setDirty(true); }}
                rows={2}
              />
            </div>

            {/* Target Audience */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Target Audience
              </label>
              <Input
                value={profile.targetAudience}
                onChange={(e) => { setProfile({ ...profile, targetAudience: e.target.value }); setDirty(true); }}
              />
            </div>

            <Separator />

            {/* Array fields */}
            {(
              [
                { key: "subreddits", label: "Subreddits to Scan", hint: "Only subreddits directly about this niche" },
                { key: "etsyKeywords", label: "Etsy In-Niche Keywords", hint: "Search terms buyers in this niche would type" },
                { key: "generalBestSellerTerms", label: "General Best-Seller Search Terms", hint: "Broad product-type terms (e.g. 'funny shirt', 'graphic tee') — always scraped" },
                { key: "crossNicheCategories", label: "Cross-Niche Scan Categories", hint: "Hot sellers in UNRELATED niches with transferable design patterns" },
                { key: "culturalMoments", label: "Cultural Moments / Inside Jokes", hint: "Real phrases and memes insiders recognize" },
                { key: "designStyles", label: "Design Styles", hint: "Visual styles that resonate with this audience" },
                { key: "avoidTopics", label: "Avoid Topics", hint: "Competitor niches, generic slogans, oversaturated angles" },
              ] as { key: keyof NicheProfile; label: string; hint: string }[]
            ).map(({ key, label, hint }) => (
              <div key={key} className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </label>
                  <span className="text-[10px] text-muted-foreground">{hint}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {((profile[key] as string[] | undefined) ?? []).map((item, i) => (
                    <div key={i} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1">
                      <input
                        className="bg-transparent text-xs outline-none min-w-0 w-auto"
                        style={{ width: `${Math.max(item.length, 4)}ch` }}
                        value={item}
                        onChange={(e) => updateProfileArray(key, i, e.target.value)}
                      />
                      <button
                        onClick={() => removeProfileItem(key, i)}
                        className="text-muted-foreground hover:text-destructive ml-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addProfileItem(key)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-dashed border-border"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Deep Cultural Map — editable */}
      {isNicheHunter && profile?.culturalMap && (
        <CulturalMapEditor
          culturalMap={profile.culturalMap}
          onChange={(updated) => {
            setProfile({ ...profile, culturalMap: updated });
            setDirty(true);
          }}
        />
      )}

      {/* NYT workspace info */}
      {!isNicheHunter && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              The NYT Books workspace uses the built-in NYT Best Sellers pipeline. No niche profile configuration is needed.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Save button at bottom too */}
      {dirty && (
        <div className="flex justify-end pb-8">
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            style={{ backgroundColor: "#22C55E" }}
            className="text-white hover:opacity-90"
          >
            {updateMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Changes
          </Button>
        </div>
      )}

      {/* Danger Zone — Delete Workspace */}
      {workspace.ownerId !== "system" && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base text-destructive" style={{ fontFamily: "Syne, sans-serif" }}>
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Delete this workspace</p>
                <p className="text-xs text-muted-foreground">This action cannot be undone. All scan data will be lost.</p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete Workspace
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete "{workspace.name}"?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete the workspace, all its credentials, scan runs, and discovered patterns. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={async () => {
                        try {
                          await deleteMutation.mutateAsync({ id: workspace.id });
                        } catch {}
                      }}
                    >
                      {deleteMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 h-4 w-4" />
                      )}
                      Delete Forever
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
