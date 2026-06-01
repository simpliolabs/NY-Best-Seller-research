/**
 * WorkspaceSwitcher — Phase B update
 * Shows workspace tabs + a "New Workspace" button.
 * Single workspace: shows name + small "+ New" link.
 * Multiple workspaces: shows tabs + "+" icon button.
 */
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, setActiveWorkspace, isLoading } = useWorkspace();
  const [, setLocation] = useLocation();

  if (isLoading) return null;

  // Single workspace: compact row with name + "+ New" button
  if (workspaces.length <= 1) {
    return (
      <div className="px-3 pb-2 pt-1 flex items-center justify-between">
        <span className="text-xs text-zinc-400 truncate">
          {workspaces[0] ? `${workspaces[0].icon} ${workspaces[0].name}` : ""}
        </span>
        <button
          onClick={() => setLocation("/workspace/new")}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-[#22C55E] transition-colors px-1.5 py-1 rounded-md hover:bg-zinc-800"
          title="New Workspace"
        >
          <Plus className="h-3 w-3" />
          <span>New</span>
        </button>
      </div>
    );
  }

  // Multiple workspaces: tabs + "+" button
  return (
    <div className="px-3 pb-2 pt-1">
      <div className="flex gap-1 rounded-lg bg-zinc-900/60 p-1">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => setActiveWorkspace(ws)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              activeWorkspace?.id === ws.id
                ? "bg-zinc-700 text-white shadow-sm"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            )}
            title={ws.name}
          >
            <span>{ws.icon}</span>
            <span className="truncate">{ws.name}</span>
          </button>
        ))}
        <button
          onClick={() => setLocation("/workspace/new")}
          className="flex items-center justify-center w-8 rounded-md text-zinc-400 hover:text-[#22C55E] hover:bg-zinc-800 transition-colors"
          title="New Workspace"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
