'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo } from 'react';
import type { ProjectRole, WorkspaceRole } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/ui/loader';
import { AbilityProvider, buildAbility } from '@/lib/ability';
import { isAuthFailure, sessionQueryOptions } from '@/lib/session-query';
import { readSupportWorkspace, writeSupportWorkspace } from '@/lib/support-session';
import {
  clearWorkspaceCookie,
  readWorkspaceCookie,
  writeWorkspaceCookie,
} from '@/lib/workspace-cookie';

export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useQuery(sessionQueryOptions);
  const authFailed = session.isError && isAuthFailure(session.error);
  // A client-portal account never renders the internal app: the API refuses
  // it on every internal route, and mounting the app shell would fire those
  // requests (and the realtime socket) anyway.
  const isPortalAccount = session.data?.user.accountType === 'CLIENT';

  useEffect(() => {
    if (isPortalAccount) router.replace('/portal');
  }, [isPortalAccount, router]);

  // Only a real 401/403 signs the user out. Network errors, 5xx and 429 are
  // retried by the query and, if they persist, shown as "reconnecting" below
  // while the cookie stays untouched.
  useEffect(() => {
    if (authFailed) router.replace('/sign-in');
  }, [authFailed, router]);

  // Stale workspace cookie: the API silently falls back to the first
  // membership when the cookie names a workspace the user no longer belongs
  // to, which would quietly show (and write into) a different workspace.
  // Reconcile once the session says which workspace is actually active.
  useEffect(() => {
    const data = session.data;
    if (!data || data.user.accountType === 'CLIENT') return;
    // Read only support session: the active workspace lives in this tab's
    // storage, so the shared cookie (the operator's own workspace in every
    // other tab) is never touched.
    if (data.support) {
      const stored = readSupportWorkspace();
      const valid =
        stored !== null && data.workspaceMemberships.some((m) => m.workspaceId === stored);
      if (!valid) writeSupportWorkspace(data.currentWorkspaceId ?? null);
      return;
    }
    const cookie = readWorkspaceCookie();
    const isMember = (id: string) => data.workspaceMemberships.some((m) => m.workspaceId === id);
    if (cookie && !isMember(cookie)) {
      clearWorkspaceCookie();
      if (data.workspaceMemberships.length > 1) {
        router.replace('/select-workspace');
        return;
      }
    }
    if (!readWorkspaceCookie() && data.currentWorkspaceId) {
      writeWorkspaceCookie(data.currentWorkspaceId);
    }
  }, [session.data, router]);

  const ability = useMemo(() => {
    const data = session.data;
    if (!data) return null;
    // Mirror the API's PermissionsGuard: only the ACTIVE workspace's
    // memberships feed the ability, so UI hints match what the server allows.
    const active = data.currentWorkspaceId;
    return buildAbility(
      {
        userId: data.user.id,
        // Pass systemRole so the client `<Can>` UX hints match the server
        // gate on Lead/Client (ADMIN/HR only). Without it the sidebar /
        // sales menu items show for everyone and the server then 403s on
        // click - confusing UX.
        systemRole: data.user.systemRole,
        // Effective permissions (custom roles + overrides) from the API, so
        // the client ability matches the server's.
        ...(data.permissions ? { permissions: data.permissions } : {}),
        workspaceMemberships: data.workspaceMemberships
          .filter((m) => m.workspaceId === active)
          .map((m) => ({
            workspaceId: m.workspaceId,
            role: m.role as WorkspaceRole,
          })),
        projectMemberships: data.projectMemberships
          .filter((m) => m.workspaceId === active)
          .map((m) => ({
            projectId: m.projectId,
            workspaceId: m.workspaceId,
            role: m.role as ProjectRole,
            abilities: m.abilities,
          })),
      },
      // Read only support session: the API's read only ability, so write
      // controls hide. The server still refuses every write.
      { support: !!data.support },
    );
  }, [session.data]);

  if (authFailed) {
    return <PageLoader fullScreen label="Redirecting to sign-in" />;
  }

  if (isPortalAccount) {
    return <PageLoader fullScreen label="Opening your client portal" />;
  }

  // No session data yet. Either the first load is still running (including
  // its retries) or every retry failed without an auth answer.
  if (!session.data || !ability) {
    if (session.isError) {
      return (
        <div className="grid min-h-screen place-items-center px-4">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-ink text-sm font-medium">Can&apos;t reach the server</p>
            <p className="text-ink-muted text-sm">
              You are still signed in. Check your connection, then try again.
            </p>
            <Button onClick={() => void session.refetch()} disabled={session.isFetching}>
              {session.isFetching ? 'Retrying' : 'Try again'}
            </Button>
          </div>
        </div>
      );
    }
    return <PageLoader fullScreen label="Loading workspace" />;
  }

  return (
    <AbilityProvider value={ability}>
      {children}
      {session.isError ? <ReconnectingPill /> : null}
    </AbilityProvider>
  );
}

/** Shown over a working app when background session refreshes are failing. */
function ReconnectingPill() {
  return (
    <div
      role="status"
      className="border-line bg-bg-surface text-ink-muted shadow-soft pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-medium"
    >
      Reconnecting
    </div>
  );
}

export function useSessionContext() {
  return useQuery(sessionQueryOptions);
}
