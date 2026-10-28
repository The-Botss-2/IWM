'use client';

import { type ReactNode, useState } from 'react';

import { getErrorToastCount, toastError } from '@/lib/toast';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input } from './input';
import { Label } from './label';

/**
 * Run a confirm handler without leaking an unhandled rejection. Handlers are
 * usually `await x.mutateAsync()`, whose failure the hook's onError or the
 * global MutationCache handler already toasts; anything that failed without
 * any error toast being shown gets a generic one.
 */
function runConfirm(onConfirm: () => void | Promise<void>): void {
  const before = getErrorToastCount();
  const reportIfUnreported = (err: unknown) => {
    setTimeout(() => {
      if (getErrorToastCount() === before) toastError(err, 'Something went wrong');
    }, 0);
  };
  try {
    void Promise.resolve(onConfirm()).catch(reportIfUnreported);
  } catch (err) {
    reportIfUnreported(err);
  }
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'destructive';
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-ink-muted text-sm">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'primary'}
            onClick={() => runConfirm(onConfirm)}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmByTypingDialog({
  open,
  onOpenChange,
  title,
  description,
  challenge,
  challengeLabel = 'Type to confirm',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  challenge: string;
  challengeLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
}) {
  const [value, setValue] = useState('');
  const matches = value === challenge;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setValue('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-ink-muted text-sm">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="confirm-typing">
            {challengeLabel}: <span className="text-ink font-mono">{challenge}</span>
          </Label>
          <Input
            id="confirm-typing"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={challenge}
            aria-invalid={value.length > 0 && !matches}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => runConfirm(onConfirm)}
            disabled={!matches || pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
