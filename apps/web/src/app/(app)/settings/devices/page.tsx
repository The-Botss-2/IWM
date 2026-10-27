'use client';

import { Laptop, LogOut, Smartphone } from 'lucide-react';
import { useState } from 'react';
import type { MySession } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useMySessions,
  useRevokeMySession,
  useRevokeOtherSessions,
} from '@/hooks/use-my-sessions';
import { relativeTime } from '@/lib/time';

const MOBILE_OS = new Set(['iOS', 'iPadOS', 'Android']);

/**
 * /settings/devices - every device signed in to the caller's account, with a
 * per-device "Sign out" and a bulk "Sign out of all other devices". The server
 * only ever touches the caller's own sessions.
 */
export default function DevicesSettingsPage() {
  const sessions = useMySessions();
  const revokeOne = useRevokeMySession();
  const revokeOthers = useRevokeOtherSessions();
  const [target, setTarget] = useState<MySession | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);

  const items = sessions.data?.items ?? [];
  const hasOthers = items.some((s) => !s.current);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Devices</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Where you are signed in. Sign out of any device you do not recognize.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!hasOthers || revokeOthers.isPending}
          onClick={() => setConfirmOthers(true)}
        >
          Sign out of all other devices
        </Button>
      </header>

      {sessions.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : sessions.isError ? (
        <QueryError
          message="Your devices could not be loaded."
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-bg-surface">
          {items.map((s) => {
            const Icon = MOBILE_OS.has(s.os) ? Smartphone : Laptop;
            return (
              <li key={s.id} className="flex items-center gap-3 p-4">
                <Icon className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {s.device} ({s.browser})
                    </span>
                    {s.current ? <Badge>This device</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {s.os}
                    {s.ipAddress ? ` · ${s.ipAddress}` : ''} ·{' '}
                    {s.current
                      ? 'Active now'
                      : `Signed in ${relativeTime(s.createdAt)} · Last refreshed ${relativeTime(s.lastActiveAt)}`}
                  </p>
                </div>
                {s.current ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Sign out ${s.device}`}
                    onClick={() => setTarget(s)}
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!target}
        onOpenChange={(next) => !next && setTarget(null)}
        title="Sign out this device"
        description={
          target
            ? `${target.device} (${target.browser}) will need to sign in again.`
            : undefined
        }
        confirmLabel="Sign out"
        variant="destructive"
        pending={revokeOne.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revokeOne.mutateAsync(target.id);
          } catch {
            // toasted by the hook's onError
          } finally {
            setTarget(null);
          }
        }}
      />
      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title="Sign out of all other devices"
        description="Every device except this one will need to sign in again."
        confirmLabel="Sign out others"
        variant="destructive"
        pending={revokeOthers.isPending}
        onConfirm={async () => {
          try {
            await revokeOthers.mutateAsync();
          } catch {
            // toasted by the hook's onError
          } finally {
            setConfirmOthers(false);
          }
        }}
      />
    </div>
  );
}
