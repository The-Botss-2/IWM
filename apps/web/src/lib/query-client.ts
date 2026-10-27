'use client';

import { type Mutation, MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { handleSupportSessionError } from './support-session';
import { getErrorToastCount, toastError, toastSuccess } from './toast';

/**
 * Typed `meta` that drives the global toast behaviour below.
 *
 * Mutations (declare on the `useMutation` in the hook):
 * - `errorTitle`     headline of the error toast (default "Something went wrong").
 * - `successMessage` when set, a success toast is shown on success.
 * - `silentError`    never toast this mutation's errors globally (best-effort
 *                    calls, or the caller renders its own inline feedback).
 *
 * Queries:
 * - `errorTitle`     opt in to a toast when the first load fails (any status).
 * - `silentError`    never toast (the page renders its own error state).
 */
export interface AppMutationMeta extends Record<string, unknown> {
  errorTitle?: string;
  successMessage?: string;
  silentError?: boolean;
}

export interface AppQueryMeta extends Record<string, unknown> {
  errorTitle?: string;
  silentError?: boolean;
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: AppMutationMeta;
    queryMeta: AppQueryMeta;
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Global mutation-error toasts without double toasting.
 *
 * Plenty of call sites already report failures themselves - a hook-level
 * `onError`, a per-call `mutate(vars, { onError })`, or `try { await
 * mutateAsync() } catch { toast... }`. TanStack calls the cache-level
 * `onError` *first*, so we snapshot the error-toast counter there, let every
 * local handler run (hook `onError` -> dispatch -> per-call `onError` ->
 * `mutateAsync` rejection), and only toast on the next macrotask if nobody
 * else showed an error toast in between.
 */
const errorToastSnapshot = new WeakMap<Mutation<unknown, unknown, unknown, unknown>, number>();

function reportUnhandledMutationError(
  error: unknown,
  mutation: Mutation<unknown, unknown, unknown, unknown>,
): void {
  const before = errorToastSnapshot.get(mutation);
  errorToastSnapshot.delete(mutation);
  if (before === undefined || mutation.meta?.silentError) return;
  setTimeout(() => {
    if (getErrorToastCount() !== before) return; // a local handler reported it
    toastError(error, mutation.meta?.errorTitle ?? 'Something went wrong');
  }, 0);
}

let client: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!client) {
    const mutationCache = new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // A support session the server ended: leave it (reloads the app).
        if (handleSupportSessionError(error)) return;
        errorToastSnapshot.set(mutation, getErrorToastCount());
      },
      onSuccess: (_data, _variables, _context, mutation) => {
        const message = mutation.meta?.successMessage;
        if (message) toastSuccess(message);
      },
    });
    // The 'error' dispatch fires after the hook-level onError has run and in
    // the same tick as per-call onError callbacks (see note above).
    mutationCache.subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        reportUnhandledMutationError(event.action.error, event.mutation);
      }
    });

    client = new QueryClient({
      mutationCache,
      queryCache: new QueryCache({
        onError: (error, query) => {
          if (handleSupportSessionError(error)) return;
          if (query.meta?.silentError) return;
          // Background refetch failures keep showing cached data - stay quiet.
          if (query.state.data !== undefined) return;
          const status = statusOf(error);
          // 401 -> SessionGate redirects to sign-in. Other 4xx on reads are
          // usually expected (no access / gone) and pages render that inline;
          // only queries that opt in with `meta.errorTitle` toast them.
          if (status === 401) return;
          const unexpected = status === undefined || status >= 500;
          if (!unexpected && !query.meta?.errorTitle) return;
          toastError(error, query.meta?.errorTitle ?? "Couldn't load data");
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 5 * 60_000,
          refetchOnWindowFocus: false,
          // Any query that opts into `refetchInterval` still goes quiet while
          // the tab/window is hidden (tray, background) - no radio wakeups for
          // a screen nobody is looking at. Per-query intervals can override.
          refetchIntervalInBackground: false,
          retry: (failureCount, err: unknown) => {
            const status = (err as { status?: number })?.status;
            if (status && status < 500) return false;
            return failureCount < 2;
          },
        },
      },
    });
  }
  return client;
}
