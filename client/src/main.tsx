import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Self-healing: auto-retry network/server errors up to 2 times
      retry: (failureCount, error) => {
        // Don't retry auth errors
        if (error instanceof TRPCClientError && error.message === UNAUTHED_ERR_MSG) return false;
        // Don't retry 4xx client errors (except 429 rate limit)
        if (error instanceof TRPCClientError && error.data?.httpStatus && error.data.httpStatus >= 400 && error.data.httpStatus < 500 && error.data.httpStatus !== 429) return false;
        return failureCount < 2;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      // Refetch stale data when window regains focus (auto-reconnect)
      refetchOnWindowFocus: true,
      // Refetch when network comes back online
      refetchOnReconnect: true,
      // Keep data fresh for 30s
      staleTime: 30_000,
    },
    mutations: {
      retry: (failureCount, error) => {
        // Only retry mutations on network errors, not business logic errors
        if (error instanceof TRPCClientError && error.data?.httpStatus && error.data.httpStatus >= 400 && error.data.httpStatus < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
