/**
 * useWorkspaceNav — helper hook for workspace-scoped navigation.
 * Returns a `nav(path)` function that prepends the active workspace slug.
 * Also returns `linkTo(path)` for building href strings.
 */
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useLocation } from "wouter";

export function useWorkspaceNav() {
  const { activeWorkspace } = useWorkspace();
  const [, setLocation] = useLocation();
  const slug = activeWorkspace?.slug ?? "";

  function nav(path: string) {
    setLocation(`/${slug}${path}`);
  }

  function linkTo(path: string) {
    return `/${slug}${path}`;
  }

  return { nav, linkTo, slug };
}
