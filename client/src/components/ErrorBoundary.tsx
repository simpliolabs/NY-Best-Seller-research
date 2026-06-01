import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw, Activity, Wifi, WifiOff } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** If true, auto-retry once after 2s on first error (self-healing tier 1) */
  autoRetry?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  isRetrying: boolean;
  isOnline: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
      isRetrying: false,
      isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
    };
  }

  componentDidMount() {
    // Auto-reconnect: listen for online/offline events
    this.onlineHandler = () => {
      this.setState({ isOnline: true });
      // If we had an error and just came back online, auto-retry
      if (this.state.hasError) {
        this.handleRetry();
      }
    };
    this.offlineHandler = () => this.setState({ isOnline: false });

    window.addEventListener("online", this.onlineHandler);
    window.addEventListener("offline", this.offlineHandler);
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.onlineHandler) window.removeEventListener("online", this.onlineHandler);
    if (this.offlineHandler) window.removeEventListener("offline", this.offlineHandler);
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[SelfHeal:Frontend] Error caught:", error.message, info.componentStack);

    // Tier 1: Auto-retry once if enabled and this is the first error
    if (this.props.autoRetry !== false && this.state.retryCount === 0) {
      this.setState({ isRetrying: true });
      this.retryTimer = setTimeout(() => {
        this.handleRetry();
      }, 2000);
    }
  }

  handleRetry = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1,
      isRetrying: false,
    }));
  };

  handleFullReload = () => {
    // Clear any stale React state by doing a full page reload
    window.location.reload();
  };

  render() {
    if (this.state.isRetrying) {
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center gap-4">
            <Activity size={32} className="text-amber-500 animate-pulse" />
            <p className="text-muted-foreground">Self-healing: auto-recovering...</p>
          </div>
        </div>
      );
    }

    if (this.state.hasError) {
      const isNetworkError =
        this.state.error?.message?.includes("fetch") ||
        this.state.error?.message?.includes("network") ||
        this.state.error?.message?.includes("Failed to load") ||
        !this.state.isOnline;

      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            {isNetworkError ? (
              <WifiOff size={48} className="text-amber-500 mb-6 flex-shrink-0" />
            ) : (
              <AlertTriangle size={48} className="text-destructive mb-6 flex-shrink-0" />
            )}

            <h2 className="text-xl mb-2 text-foreground font-semibold">
              {isNetworkError ? "Connection Lost" : "Something went wrong"}
            </h2>

            <p className="text-sm text-muted-foreground mb-4 text-center">
              {isNetworkError
                ? "The app lost connection to the server. It will auto-reconnect when your network is back."
                : this.state.retryCount > 0
                  ? "Auto-recovery failed. You can try again or reload the page."
                  : "An unexpected error occurred."}
            </p>

            {this.state.error && (
              <div className="p-4 w-full rounded bg-muted overflow-auto mb-6 max-h-40">
                <pre className="text-xs text-muted-foreground whitespace-break-spaces">
                  {this.state.error.message}
                </pre>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={this.handleRetry}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg",
                  "bg-primary text-primary-foreground",
                  "hover:opacity-90 cursor-pointer"
                )}
              >
                <RotateCcw size={16} />
                Try Again
              </button>
              <button
                onClick={this.handleFullReload}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg",
                  "border border-border text-foreground",
                  "hover:bg-muted cursor-pointer"
                )}
              >
                <Wifi size={16} />
                Full Reload
              </button>
            </div>

            {!this.state.isOnline && (
              <div className="mt-4 flex items-center gap-2 text-amber-500 text-sm">
                <WifiOff size={14} />
                <span>You are offline — will auto-retry when connected</span>
              </div>
            )}

            {this.state.retryCount > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Recovery attempts: {this.state.retryCount}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
