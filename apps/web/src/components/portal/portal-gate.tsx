'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { PortalProvider } from '@/components/portal/portal-context';
import { PortalLoadError, PortalNoAccess } from '@/components/portal/portal-states';
import { PageLoader } from '@/components/ui/loader';
import { portalErrorStatus, usePortalAccessWatch, usePortalMeQuery } from '@/hooks/use-portal';
import { isAuthFailure, sessionQueryOptions } from '@/lib/session-query';

/**
 * The client portal's counterpart to `SessionGate`. Portal pages render only
 * for a signed-in CLIENT account with at least one live client:
 *
 * - no session (a real 401/403 from `/auth/me`): off to sign-in;
 * - a staff account: off to the internal app, staff never see the portal;
 * - offline or a server fault: a retry screen, the cookie stays untouched;
 * - no clients left: a "your access has been removed" screen.
 *
 * It mounts no realtime socket, no push and no CASL: none of that is open to
 * a client account, and the API refuses it on every internal route anyway.
 */
export function PortalGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useQuery(sessionQueryOptions);
  const authFailed = session.isError && isAuthFailure(session.error);
  const accountType = session.data?.user.accountType;
  const isStaff = accountType !== undefined && accountType !== 'CLIENT';

  const me = usePortalMeQuery(accountType === 'CLIENT');
  // 401 only. A 403 here is not "signed out"; it falls through to the error
  // screen below, which offers a retry and a sign-out.
  const meSignedOut = me.isError && portalErrorStatus(me.error) === 401;
  usePortalAccessWatch();

  const toSignIn = authFailed || meSignedOut;
  useEffect(() => {
    if (toSignIn) router.replace('/sign-in');
  }, [toSignIn, router]);

  useEffect(() => {
    if (isStaff) router.replace('/home');
  }, [isStaff, router]);

  if (toSignIn) return <PageLoader fullScreen label="Redirecting to sign-in" />;
  if (isStaff) return <PageLoader fullScreen label="Opening the app" />;

  // Still loading (including retries), or every retry failed without an
  // auth answer.
  if (!session.data) {
    if (session.isError) {
      return (
        <PortalLoadError
          offline
          onRetry={() => void session.refetch()}
          retrying={session.isFetching}
        />
      );
    }
    return <PageLoader fullScreen label="Loading your portal" />;
  }

  if (!me.data) {
    if (me.isError) {
      return (
        <PortalLoadError
          offline={portalErrorStatus(me.error) === 0}
          onRetry={() => void me.refetch()}
          retrying={me.isFetching}
        />
      );
    }
    return <PageLoader fullScreen label="Loading your portal" />;
  }

  if (me.data.clients.length === 0) return <PortalNoAccess fullScreen />;

  return <PortalProvider me={me.data}>{children}</PortalProvider>;
}
