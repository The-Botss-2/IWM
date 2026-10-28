'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { useSelfSetupMailbox } from '@/hooks/use-mail-accounts';

/**
 * One-click mailbox setup for users on the cPanel-managed domain. The password
 * the user types is set on cPanel AND used to provision the MailAccount, so
 * IMAP verification can't fail with a stale credential. This is the path the
 * admin uses to bootstrap themselves once on a fresh deploy - or any
 * pre-existing user that was never wired through the admin Users panel.
 */
export function SelfSetupMailboxDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}) {
  const setup = useSelfSetupMailbox();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPassword('');
    setConfirm('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    try {
      await setup.mutateAsync(password);
      reset();
      onOpenChange(false);
    } catch {
      // toast surfaced by the hook
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="text-brand-500 h-4 w-4" />
            Set up your mailbox
          </DialogTitle>
          <DialogDescription>
            One click. We&apos;ll reset your webmail password on the server, store it encrypted on
            our side, and connect your inbox. No need to fiddle with IMAP/SMTP settings.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit} noValidate>
          <div className="border-line bg-bg-subtle rounded-md border px-3 py-2 text-sm">
            <div className="text-ink-muted text-xs">Mailbox</div>
            <div className="text-ink font-mono">{email}</div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ssm-password">New password</Label>
            <PasswordInput
              id="ssm-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="text-ink-muted text-[11px]">
              This becomes your password for both this app and your webmail. Your old webmail
              password stops working as soon as you save.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ssm-confirm">Confirm password</Label>
            <PasswordInput
              id="ssm-confirm"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {error ? (
            <p className="bg-tint-error text-state-error rounded-md border border-red-100 px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={setup.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={setup.isPending}>
              {setup.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Setting up…
                </>
              ) : (
                <>Set up</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
