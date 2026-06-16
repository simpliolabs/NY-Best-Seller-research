/** Build identity — forces unique bundle hash per deploy */
export const __BUILD_VERSION__ = "dismiss-panel-v2";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect, useParams } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import { WorkspaceProvider, useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "./_core/hooks/useAuth";
import { getLoginUrl } from "./const";

import Dashboard from "./pages/Dashboard";
import Analytics from "./pages/Analytics";
import Library from "./pages/Library";
import History from "./pages/History";
import BookDetail from "./pages/BookDetail";
import ReportDetail from "./pages/ReportDetail";
import Favorites from "./pages/Favorites";
import Status from "./pages/Status";
import SystemHealth from "./pages/SystemHealth";
import OnboardingWizard from "./pages/OnboardingWizard";
import ProductGroups from "./pages/ProductGroups";
import WorkspaceSettings from "./pages/WorkspaceSettings";
import NicheHunter from "./pages/NicheHunter";
import Mockups from "./pages/Mockups";
import DesignStudio from "./pages/DesignStudio";
import Listings from "./pages/Listings";

/**
 * WorkspaceRedirect — redirects "/" to "/:activeSlug" based on active workspace.
 */
function WorkspaceRedirect() {
  const { activeWorkspace, isLoading } = useWorkspace();
  const { loading, user } = useAuth();
  if (loading || isLoading) return null;
  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <h1 className="text-2xl font-semibold tracking-tight text-center">NYT Design Bot</h1>
          <p className="text-muted-foreground text-center">Sign in to access your workspaces.</p>
          <a href={getLoginUrl()} className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-6 py-3 font-medium hover:bg-primary/90 transition-colors">Sign In</a>
        </div>
      </div>
    );
  }
  if (!activeWorkspace) return null;
  return <Redirect to={`/${activeWorkspace.slug}`} />;
}

/**
 * LegacySlugRedirect — redirects old slug-less paths to /:activeSlug/...
 * Used for every route that previously existed without a workspace prefix.
 * Falls back to "nyt-books" if workspace context is still loading.
 */
function LegacySlugRedirect({ suffix }: { suffix: string }) {
  const { activeWorkspace, isLoading } = useWorkspace();
  if (isLoading) return null;
  const slug = activeWorkspace?.slug ?? "nyt-books";
  return <Redirect to={`/${slug}${suffix}`} />;
}

/** Legacy /book/:id → /:slug/book/:id */
function LegacyBookRedirect() {
  const params = useParams<{ id: string }>();
  return <LegacySlugRedirect suffix={`/book/${params.id}`} />;
}

/** Legacy /report/:id → /:slug/report/:id */
function LegacyReportRedirect() {
  const params = useParams<{ id: string }>();
  return <LegacySlugRedirect suffix={`/report/${params.id}`} />;
}

/**
 * WorkspaceRoutes — all routes scoped under /:slug/...
 * The slug is extracted by DashboardLayout which syncs it with WorkspaceContext.
 */
function WorkspaceRoutes() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/:slug" component={Dashboard} />
        <Route path="/:slug/analytics" component={Analytics} />
        <Route path="/:slug/library" component={Library} />
        <Route path="/:slug/history" component={History} />
        <Route path="/:slug/book/:id" component={BookDetail} />
        <Route path="/:slug/report/:id" component={ReportDetail} />
        <Route path="/:slug/favorites" component={Favorites} />
        <Route path="/:slug/status" component={Status} />
        <Route path="/:slug/health" component={SystemHealth} />
        <Route path="/:slug/product-groups" component={ProductGroups} />
        <Route path="/:slug/workspace-settings" component={WorkspaceSettings} />
        <Route path="/:slug/niche-hunter" component={NicheHunter} />
        <Route path="/:slug/mockups" component={Mockups} />
        <Route path="/:slug/design-studio" component={DesignStudio} />
        <Route path="/:slug/listings" component={Listings} />
        <Route path="/:slug/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Switch>
      {/* Wizard renders outside DashboardLayout — full-screen experience */}
      <Route path="/workspace/new" component={OnboardingWizard} />

      {/* ── Legacy 301-style client redirects (old slug-less URLs) ── */}
      {/* /book/:id  → /:slug/book/:id */}
      <Route path="/book/:id" component={LegacyBookRedirect} />
      {/* /report/:id → /:slug/report/:id */}
      <Route path="/report/:id" component={LegacyReportRedirect} />
      {/* Flat pages → /:slug/page */}
      <Route path="/analytics">{() => <LegacySlugRedirect suffix="/analytics" />}</Route>
      <Route path="/library">{() => <LegacySlugRedirect suffix="/library" />}</Route>
      <Route path="/history">{() => <LegacySlugRedirect suffix="/history" />}</Route>
      <Route path="/favorites">{() => <LegacySlugRedirect suffix="/favorites" />}</Route>
      <Route path="/status">{() => <LegacySlugRedirect suffix="/status" />}</Route>
      <Route path="/health">{() => <LegacySlugRedirect suffix="/health" />}</Route>
      <Route path="/product-groups">{() => <LegacySlugRedirect suffix="/product-groups" />}</Route>
      <Route path="/workspace-settings">{() => <LegacySlugRedirect suffix="/workspace-settings" />}</Route>
      <Route path="/niche-hunter">{() => <LegacySlugRedirect suffix="/niche-hunter" />}</Route>
      <Route path="/mockups">{() => <LegacySlugRedirect suffix="/mockups" />}</Route>
      <Route path="/design-studio">{() => <LegacySlugRedirect suffix="/design-studio" />}</Route>
      <Route path="/listings">{() => <LegacySlugRedirect suffix="/listings" />}</Route>

      {/* Root redirects to active workspace slug */}
      <Route path="/">
        {() => <WorkspaceRedirect />}
      </Route>

      {/* All workspace-scoped routes */}
      <Route>
        {() => <WorkspaceRoutes />}
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <WorkspaceProvider>
            <Toaster />
            <Router />
          </WorkspaceProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
