'use client';

import { ChevronDown, Mail } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@botss/api-client';
import { type PayrollRun, sendPayslipsSchema } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSendPayslips } from '@/hooks/use-payroll';
import { payrollPeriod } from '@/lib/payroll';
import { describeError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** The sender address is remembered per browser; the password never is. */
const SENDER_KEY = 'botss.payroll.payslipSender';

function rememberedSender(): string {
  try {
    return window.localStorage.getItem(SENDER_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberSender(email: string): void {
  try {
    window.localStorage.setItem(SENDER_KEY, email);
  } catch {
    // Storage blocked: the field just starts empty next time.
  }
}

/**
 * Email payslips from an HR mailbox to the people picked here. The password
 * is held in this dialog only while it is open and cleared when it closes.
 */
export function SendPayslipsDialog({
  run,
  open,
  onOpenChange,
}: {
  run: PayrollRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sending = useSendPayslips(run.id);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [security, setSecurity] = useState<'ssl' | 'starttls'>('ssl');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const reachable = useMemo(() => run.items.filter((i) => !!i.email), [run.items]);

  // Payslips that went out during this send, read from the refreshed run:
  // anything whose sent time changed since sending started. Server times on
  // both sides, so the browser clock does not matter.
  const sentNow = useMemo(() => {
    const ids = new Set<string>();
    for (const i of run.items) {
      if (!sending.before.has(i.id)) continue;
      const at = i.payslipSentAt ? new Date(i.payslipSentAt).getTime() : null;
      if (at !== sending.before.get(i.id)) ids.add(i.id);
    }
    return ids;
  }, [run.items, sending.before]);

  // A send that stopped before reporting anything may still have reached
  // some people; take them out of the selection so they are not sent twice.
  useEffect(() => {
    if (!sending.error || sentNow.size === 0) return;
    setSelected((prev) => new Set([...prev].filter((id) => !sentNow.has(id))));
  }, [sending.error, sentNow]);

  useEffect(() => {
    if (!open) {
      setPassword('');
      sending.reset();
      return;
    }
    setEmail(rememberedSender());
    setFormError(null);
    setSearch('');
    // Start with everyone not emailed yet; everyone, if they all were.
    const unsent = reachable.filter((i) => !i.payslipSentAt);
    setSelected(new Set((unsent.length > 0 ? unsent : reachable).map((i) => i.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset once per open
  }, [open]);

  // The server could not tell which mail server to use: ask for it.
  useEffect(() => {
    if (
      sending.error instanceof ApiError &&
      sending.error.problem.code === 'payroll_smtp_host_required'
    ) {
      setShowServer(true);
    }
  }, [sending.error]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return run.items;
    return run.items.filter((i) =>
      `${i.employeeName} ${i.email ?? ''}`.toLowerCase().includes(term),
    );
  }, [run.items, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function login() {
    const parsed = sendPayslipsSchema.omit({ itemIds: true }).safeParse({
      email: email.trim(),
      password,
      ...(showServer && host.trim()
        ? {
            smtpHost: host.trim(),
            ...(port.trim() ? { smtpPort: port.trim() } : {}),
            smtpSecure: security === 'ssl',
          }
        : {}),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setFormError(
        field === 'email'
          ? 'Enter the email address to send from.'
          : field === 'password'
            ? 'Enter the mailbox password.'
            : 'Check the mail server and port.',
      );
      return null;
    }
    return parsed.data;
  }

  async function send(ids: string[]) {
    setFormError(null);
    const creds = login();
    if (!creds) return;
    if (ids.length === 0) {
      setFormError('Select at least one person.');
      return;
    }
    rememberSender(creds.email);
    const before = new Map(
      run.items.map(
        (i) => [i.id, i.payslipSentAt ? new Date(i.payslipSentAt).getTime() : null] as const,
      ),
    );
    await sending.send(creds, ids, before);
  }

  const busy = sending.status === 'sending';
  const finished = sending.status === 'done';
  const failedIds = sending.results.filter((r) => r.status === 'FAILED').map((r) => r.itemId);
  const unsent = sending.pending.filter((id) => !sentNow.has(id));
  const retryIds = [...failedIds, ...unsent];
  const sentCount = sending.results.filter((r) => r.status === 'SENT').length;
  const allVisibleSelected = visible.filter((i) => i.email).every((i) => selected.has(i.id));

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Email payslips</DialogTitle>
          <DialogDescription>
            {payrollPeriod(run.year, run.month)}. Each person gets their own payslip as a PDF, sent
            from the mailbox below. The password is used for this send only and is not saved.
          </DialogDescription>
        </DialogHeader>

        {finished ? (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="font-medium">
                {sentCount === 1 ? '1 payslip sent' : `${sentCount} payslips sent`}
              </span>
              {failedIds.length > 0 ? (
                <span className="text-state-error"> · {failedIds.length} failed</span>
              ) : null}
              {unsent.length > 0 ? (
                <span className="text-state-error"> · {unsent.length} not sent</span>
              ) : null}
            </p>
            {sending.error ? (
              <p role="alert" className="text-state-error text-sm">
                Stopped early: {describeError(sending.error, 'Sending stopped.')}
              </p>
            ) : null}
            <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
              {sending.results.map((r) => (
                <li key={r.itemId} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {r.name}
                    {r.to ? <span className="text-ink-muted"> · {r.to}</span> : null}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-xs',
                      r.status === 'SENT'
                        ? 'text-brand-teal'
                        : r.status === 'FAILED'
                          ? 'text-state-error'
                          : 'text-ink-muted',
                    )}
                  >
                    {r.status === 'SENT'
                      ? 'Sent'
                      : r.status === 'FAILED'
                        ? (r.error ?? 'Failed')
                        : (r.error ?? 'Skipped')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="payslip-from">Send from</Label>
                <Input
                  id="payslip-from"
                  type="email"
                  autoComplete="email"
                  placeholder="hr@yourcompany.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payslip-password">Email password / app password</Label>
                <PasswordInput
                  id="payslip-password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>

            <div>
              <button
                type="button"
                className="text-ink-muted hover:text-ink flex items-center gap-1 text-xs font-medium"
                aria-expanded={showServer}
                onClick={() => setShowServer((v) => !v)}
              >
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform', showServer && 'rotate-180')}
                />
                Mail server settings
              </button>
              {showServer ? (
                <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_6rem_9rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="payslip-host">SMTP server</Label>
                    <Input
                      id="payslip-host"
                      placeholder="mail.yourcompany.com"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="payslip-port">Port</Label>
                    <Input
                      id="payslip-port"
                      inputMode="numeric"
                      placeholder={security === 'ssl' ? '465' : '587'}
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="payslip-security">Security</Label>
                    <Select
                      value={security}
                      onValueChange={(v) => setSecurity(v as 'ssl' | 'starttls')}
                    >
                      <SelectTrigger id="payslip-security" disabled={busy}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ssl">SSL/TLS</SelectItem>
                        <SelectItem value="starttls">STARTTLS</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-ink-muted text-xs sm:col-span-3">
                    Leave blank to use the settings already saved for this address&apos;s domain.
                  </p>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  People{' '}
                  <span className="text-ink-muted font-normal">({selected.size} selected)</span>
                </p>
                <div className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const i of visible) {
                          if (!i.email) continue;
                          if (allVisibleSelected) next.delete(i.id);
                          else next.add(i.id);
                        }
                        return next;
                      })
                    }
                  >
                    {allVisibleSelected ? 'Clear' : 'Select all'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setSelected(
                        new Set(reachable.filter((i) => !i.payslipSentAt).map((i) => i.id)),
                      )
                    }
                  >
                    Not emailed yet
                  </Button>
                </div>
              </div>
              {run.items.length > 8 ? (
                <Input
                  placeholder="Search people"
                  aria-label="Search people"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={busy}
                />
              ) : null}
              <ul className="border-line max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
                {visible.map((i) => (
                  <li key={i.id}>
                    <label
                      className={cn(
                        'flex items-center gap-3 rounded px-2 py-1.5 text-sm',
                        i.email ? 'hover:bg-bg-subtle cursor-pointer' : 'opacity-60',
                      )}
                    >
                      <Checkbox
                        checked={selected.has(i.id)}
                        disabled={!i.email || busy}
                        onCheckedChange={() => toggle(i.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{i.employeeName}</span>
                        <span className="text-ink-muted block truncate text-xs">
                          {i.email ?? 'No email: add one to their payroll details'}
                        </span>
                      </span>
                      {i.payslipSentAt ? (
                        <span
                          className="text-ink-muted shrink-0 text-xs"
                          title={`Sent to ${i.payslipSentTo ?? ''}`}
                        >
                          Emailed {new Date(i.payslipSentAt).toLocaleDateString()}
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            {busy ? (
              <div className="space-y-1.5" aria-live="polite">
                <div className="bg-bg-subtle h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-brand-teal h-full rounded-full transition-[width]"
                    style={{
                      width: `${sending.total ? (sending.done / sending.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="text-ink-muted text-xs">
                  Sending… {sending.done} of {sending.total}
                </p>
              </div>
            ) : null}

            {formError || (sending.error && !finished) ? (
              <p role="alert" className="text-state-error text-sm">
                {formError ?? describeError(sending.error, "Couldn't send the payslips.")}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {finished ? (
            <>
              {retryIds.length > 0 ? (
                <Button variant="secondary" onClick={() => void send(retryIds)}>
                  {unsent.length > 0 ? 'Send the rest' : 'Retry failed'}
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void send([...selected])}
                disabled={busy || selected.size === 0}
              >
                <Mail className="h-4 w-4" />
                {busy
                  ? 'Sending…'
                  : selected.size === 1
                    ? 'Email 1 payslip'
                    : `Email ${selected.size} payslips`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
