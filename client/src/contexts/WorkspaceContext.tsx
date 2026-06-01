/**
 * WorkspaceContext — URL-synced workspace state.
 * Active workspace is derived from the URL slug (/:slug/...).
 * Falls back to localStorage for initial redirect.
 */
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  icon: string;
  workspaceType: "nyt" | "niche_hunter";
};

type WorkspaceContextValue = {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  setActiveWorkspace: (ws: Workspace) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  isLoading: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspace: null,
  setActiveWorkspace: () => {},
  setActiveWorkspaceId: () => {},
  isLoading: true,
});

const STORAGE_KEY = "nyt-active-workspace-id";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = trpc.workspace.list.useQuery();
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [location, setLocation] = useLocation();

  // Extract slug from current URL path (first segment after /)
  const urlSlug = location.split("/")[1] || "";

  // Sync active workspace from URL slug
  useEffect(() => {
    if (!data || data.length === 0) return;

    // Skip slug matching for non-workspace routes
    if (urlSlug === "workspace" || urlSlug === "") {
      // Restore from localStorage for redirect
      const savedId = localStorage.getItem(STORAGE_KEY);
      const found = savedId ? data.find((w) => w.id === savedId) : null;
      setActiveWorkspaceState((found ?? data[0]) as Workspace);
      setInitialized(true);
      return;
    }

    // Find workspace by slug
    const matched = data.find((w) => w.slug === urlSlug);
    if (matched) {
      setActiveWorkspaceState(matched as Workspace);
      localStorage.setItem(STORAGE_KEY, matched.id);
    } else {
      // Slug doesn't match any workspace — fall back to saved or first
      const savedId = localStorage.getItem(STORAGE_KEY);
      const found = savedId ? data.find((w) => w.id === savedId) : null;
      setActiveWorkspaceState((found ?? data[0]) as Workspace);
    }
    setInitialized(true);
  }, [data, urlSlug]);

  function setActiveWorkspace(ws: Workspace) {
    localStorage.setItem(STORAGE_KEY, ws.id);
    setActiveWorkspaceState(ws);
    // Navigate to the new workspace's root
    setLocation(`/${ws.slug}`);
  }

  function setActiveWorkspaceId(id: string | null) {
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
      setActiveWorkspaceState(null);
    } else {
      localStorage.setItem(STORAGE_KEY, id);
      const found = (data ?? []).find((w) => w.id === id);
      if (found) {
        setActiveWorkspaceState(found as Workspace);
        setLocation(`/${found.slug}`);
      }
    }
  }

  // Report loading until both the query AND the useEffect have completed
  const effectiveLoading = isLoading || (!initialized && !!data && data.length > 0);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces: (data ?? []) as Workspace[],
        activeWorkspace,
        setActiveWorkspace,
        setActiveWorkspaceId,
        isLoading: effectiveLoading,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
