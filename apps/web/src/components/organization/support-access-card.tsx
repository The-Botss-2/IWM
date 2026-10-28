'use client';

import { History, LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { SupportGrant } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateSupportGrant,
  useRevokeSupportGrant,
  useSupportGrants,
} from '@/hooks/use-support-access';
import {
  buildSupportGrantInput,
  SUPPORT_GRANT_CHOICES,
  SUPPORT_GRANT_STATUS_LABEL,
  type SupportGrantChoice,
} from '@/lib/support-grant-form';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * Support access card (company `org.settings`): let the platform's support
 * team read this organization for a limited time, see every grant, revoke
 * one early. Every request support makes is in the audit log.
 */
export function SupportAccessCard() {
  const grants = useSupportGrants();
  const create = useCreateSupportGrant({ onSuccess: () => reset() });
  const revoke = useRevokeSupportGrant();

  const [choice, setChoice] = useState<SupportGrantChoice>('24h');
  const [customEnd, setCustomEnd] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SupportGrant | null>(null);

  function reset(): void {
    setChoice('24h');
    setCustomEnd('');
    setReason('');
    setFormError(null);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const built = buildSupportGrantInput(choice, customEnd, reason);
    if (!built.ok) {
      setFormError(built.reason);
      return;
    }
    setFormError(null);
    create.mutate(built.input);
  }

  const items = grants.data?.items ?? [];

  return (
    <section className="border-line bg-bg-surface space-y-5 rounded-lg border p-5">
      <header className="flex items-start gap-3">
        <LifeBuoy className="text-brand-orange mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div>
          <h2 className="text-ink text-lg font-semibold">Support access</h2>
          <p className="text-ink-muted mt-1 text-sm">
            Let the platform support team look around your organization to help with a problem.
            Access is read only, ends by itself, and you can revoke it at any time. Every page they
            open is recorded in your{' '}
            <Link href="/admin/audit-log" className="text-brand-blue font-medium hover:underline">
              audit log
            </Link>
            .
          </p>
          <p className="text-ink-muted mt-1 text-sm">
            Support can&apos;t open mail, chat, notifications, calls, todos or payroll. Files open
            through a link that is recorded too and stops working when access ends; a file that
            isn&apos;t stored in your workspaces shows as unavailable.
          </p>
        </div>
      </header>

      <form className="space-y-4" onSubmit={submit} noValidate>
        <fieldset className="space-y-2">
          <legend className="text-ink text-sm font-medium">How long</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {SUPPORT_GRANT_CHOICES.map((c) => (
              <label
                key={c.value}
                className={cn(
                  'cursor-pointer rounded-full border px-3 py-1.5 text-sm transition-colors',
                  choice === c.value
                    ? 'border-brand-orange bg-tint-warning text-ink'
                    : 'border-line text-ink-muted hover:bg-bg-subtle',
                )}
              >
                <input
                  type="radio"
                  name="support-duration"
                  value={c.value}
                  checked={choice === c.value}
                  onChange={() => setChoice(c.value)}
                  className="sr-only"
                />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>

        {choice === 'custom' ? (
          <div className="space-y-1.5">
            <Label htmlFor="support-end">Ends at (at most 30 days from now)</Label>
            <Input
              id="support-end"
              type="datetime-local"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="max-w-xs"
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="support-reason">Note for support (optional)</Label>
          <Textarea
            id="support-reason"
            value={reason}
            maxLength={500}
            rows={2}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What should they look at?"
          />
        </div>

        {formError ? (
          <p role="alert" className="text-state-error text-sm">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Granting…' : 'Grant read only access'}
          </Button>
        </div>
      </form>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ink text-sm font-semibold">Grants</h3>
          <Link
            href="/admin/audit-log"
            className="text-brand-blue inline-flex items-center gap-1 text-xs font-medium hover:underline"
          >
            <History className="h-3.5 w-3.5" aria-hidden />
            See support activity
          </Link>
        </div>
        {grants.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader size="sm" label="Loading" />
          </div>
        ) : grants.isError && !grants.data ? (
          <QueryError
            message="Couldn't load support grants."
            onRetry={() => void grants.refetch()}
          />
        ) : items.length === 0 ? (
          <p className="border-line bg-bg-subtle text-ink-muted rounded-md border px-3 py-4 text-center text-xs">
            Support has never had access to this organization.
          </p>
        ) : (
          <ul className="divide-line border-line divide-y rounded-md border">
            {items.map((g) => (
              <li
                key={g.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={g.status === 'ACTIVE' ? 'warning' : 'neutral'}>
                      {SUPPORT_GRANT_STATUS_LABEL[g.status]}
                    </Badge>
                    <span className="text-ink text-sm">
                      {g.status === 'ACTIVE' ? 'Ends ' : 'Ended '}
                      <span title={absoluteTime(g.revokedAt ?? g.expiresAt)}>
                        {absoluteTime(g.revokedAt ?? g.expiresAt)}
                      </span>
                    </span>
                  </div>
                  <p className="text-ink-muted text-xs">
                    Granted by {g.grantedBy?.name || g.grantedBy?.email || 'a former member'}{' '}
                    <span title={absoluteTime(g.createdAt)}>{relativeTime(g.createdAt)}</span>
                    {g.revokedAt
                      ? `, revoked by ${g.revokedBy?.name || g.revokedBy?.email || 'a former member'}`
                      : ''}
                  </p>
                  {g.reason ? <p className="text-ink-muted text-xs">Note: {g.reason}</p> : null}
                </div>
                {g.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRevokeTarget(g)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke support access?"
        description="Support loses access right away, on their very next request."
        confirmLabel="Revoke access"
        variant="destructive"
        pending={revoke.isPending}
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revoke.mutateAsync(revokeTarget.id);
          setRevokeTarget(null);
        }}
      />
    </section>
  );
}
