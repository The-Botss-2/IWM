'use client';

import { Loader2, Mail } from 'lucide-react';
import { useState } from 'react';
import type { AddMailAccountInput } from '@botss/shared-types';

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
import { useAddMailAccount } from '@/hooks/use-mail-accounts';
import { toast, toastErrorMessage } from '@/lib/toast';

// Pre-filled hosts, from NEXT_PUBLIC_MAIL_DEFAULT_IMAP_HOST /
// NEXT_PUBLIC_MAIL_DEFAULT_SMTP_HOST at build time. Empty when unset.
const DEFAULTS = {
  imapHost: (process.env.NEXT_PUBLIC_MAIL_DEFAULT_IMAP_HOST ?? '').trim(),
  imapPort: 993,
  smtpHost: (process.env.NEXT_PUBLIC_MAIL_DEFAULT_SMTP_HOST ?? '').trim(),
  smtpPort: 465,
} as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddMailAccountDialog({ open, onOpenChange }: Props) {
  const add = useAddMailAccount();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState<string>(DEFAULTS.imapHost);
  const [imapPort, setImapPort] = useState<number>(DEFAULTS.imapPort);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState<string>(DEFAULTS.smtpHost);
  const [smtpPort, setSmtpPort] = useState<number>(DEFAULTS.smtpPort);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [useSameForSmtp, setUseSameForSmtp] = useState(true);
  const [isDefault, setIsDefault] = useState(true);

  const reset = () => {
    setEmail('');
    setDisplayName('');
    setPassword('');
    setImapHost(DEFAULTS.imapHost);
    setImapPort(DEFAULTS.imapPort);
    setImapSecure(true);
    setSmtpHost(DEFAULTS.smtpHost);
    setSmtpPort(DEFAULTS.smtpPort);
    setSmtpSecure(true);
    setUseSameForSmtp(true);
    setIsDefault(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      toastErrorMessage('Email and password are required');
      return;
    }

    const input: AddMailAccountInput = {
      email: trimmedEmail,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      imapHost: imapHost.trim(),
      imapPort,
      imapSecure,
      smtpHost: (useSameForSmtp ? imapHost : smtpHost).trim(),
      smtpPort: useSameForSmtp ? smtpPort : smtpPort,
      smtpSecure: useSameForSmtp ? smtpSecure : smtpSecure,
      username: trimmedEmail,
      password,
      isDefault,
    };

    try {
      await add.mutateAsync(input);
      toast.success('Mail account added. Verifying credentials.');
      reset();
      onOpenChange(false);
    } catch {
      // Toast surfaced by mutation onError; keep dialog open so user can fix.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Mail className="text-brand-600 h-4 w-4" aria-hidden />
            Connect a mailbox
          </DialogTitle>
          <DialogDescription className="text-ink-muted text-sm">
            We will verify the credentials in the background. Once active, the mailbox can also be
            used to send password-reset and invitation email for your workspace.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-3" onSubmit={submit} noValidate>
          <Field label="Email address" htmlFor="mail-email" required>
            <Input
              id="mail-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label="Display name (shown as the sender)" htmlFor="mail-display">
            <Input
              id="mail-display"
              autoComplete="name"
              placeholder="The Botss"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>

          <Field label="Mailbox password" htmlFor="mail-password" required>
            <PasswordInput
              id="mail-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <div className="border-line bg-bg-subtle/60 rounded-md border p-3">
            <p className="text-ink-muted mb-2 text-xs font-semibold uppercase tracking-wide">
              IMAP server (receiving mail)
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_100px]">
              <Input
                aria-label="IMAP host"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="mail.example.com"
              />
              <Input
                aria-label="IMAP port"
                type="number"
                value={imapPort}
                onChange={(e) =>
                  setImapPort(Math.max(1, Math.min(65535, Number(e.target.value) || 0)))
                }
              />
            </div>
            <label className="text-ink-muted mt-2 flex items-center gap-2 text-xs">
              <Checkbox checked={imapSecure} onCheckedChange={(v) => setImapSecure(v === true)} />
              Use SSL/TLS (recommended for port 993)
            </label>
          </div>

          <label className="text-ink flex items-center gap-2 text-sm">
            <Checkbox
              checked={useSameForSmtp}
              onCheckedChange={(v) => setUseSameForSmtp(v === true)}
            />
            Use the same host for SMTP (sending)
          </label>

          {!useSameForSmtp ? (
            <div className="border-line bg-bg-subtle/60 rounded-md border p-3">
              <p className="text-ink-muted mb-2 text-xs font-semibold uppercase tracking-wide">
                SMTP server (sending mail)
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_100px]">
                <Input
                  aria-label="SMTP host"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="mail.example.com"
                />
                <Input
                  aria-label="SMTP port"
                  type="number"
                  value={smtpPort}
                  onChange={(e) =>
                    setSmtpPort(Math.max(1, Math.min(65535, Number(e.target.value) || 0)))
                  }
                />
              </div>
              <label className="text-ink-muted mt-2 flex items-center gap-2 text-xs">
                <Checkbox checked={smtpSecure} onCheckedChange={(v) => setSmtpSecure(v === true)} />
                Use SSL/TLS (recommended for port 465)
              </label>
            </div>
          ) : null}

          <label className="border-line flex items-start gap-2 rounded-md border bg-white p-3 text-sm">
            <Checkbox
              checked={isDefault}
              onCheckedChange={(v) => setIsDefault(v === true)}
              className="mt-0.5"
            />
            <span>
              <span className="text-ink block font-medium">Use for transactional email</span>
              <span className="text-ink-muted block text-xs">
                Send password reset and workspace invitation email from this mailbox. Recommended
                for one mailbox per workspace.
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={add.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Adding...
                </>
              ) : (
                'Add account'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="text-state-error ml-1" aria-label="required">
            *
          </span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}
