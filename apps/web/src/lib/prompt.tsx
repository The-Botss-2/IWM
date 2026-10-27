'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface PromptOptions {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Optional tertiary button that resolves with '' (e.g. "Remove link"). */
  clearLabel?: string;
  inputType?: 'text' | 'url';
}

type Request = PromptOptions & { resolve: (value: string | null) => void };

let listener: ((req: Request | null) => void) | null = null;

/**
 * Imperative, desktop-safe replacement for `window.prompt`, which is a no-op in
 * the Electron desktop shell (it logs a warning and returns null, so links /
 * URLs / names could never be entered there). Resolves with the entered string,
 * '' when the clear action is used, or null if cancelled. Requires
 * `<PromptHost />` mounted once at the app root.
 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!listener) {
      // No host mounted - fail closed so callers behave like a cancelled
      // prompt rather than hanging on a never-resolving promise.
      resolve(null);
      return;
    }
    listener({ ...options, resolve });
  });
}

/** Mount once near the app root so `promptDialog()` has somewhere to render. */
export function PromptHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    listener = (next) => {
      setReq(next);
      setValue(next?.defaultValue ?? '');
    };
    return () => {
      listener = null;
    };
  }, []);

  const close = (result: string | null) => {
    req?.resolve(result);
    setReq(null);
  };

  return (
    <Dialog open={req !== null} onOpenChange={(open) => (open ? null : close(null))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{req?.title ?? ''}</DialogTitle>
          {req?.description ? (
            <DialogDescription>{req.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            close(value);
          }}
        >
          <Input
            autoFocus
            type={req?.inputType ?? 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={req?.placeholder}
          />
          <DialogFooter className="mt-4">
            {req?.clearLabel ? (
              <Button type="button" variant="ghost" onClick={() => close('')}>
                {req.clearLabel}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit">{req?.confirmLabel ?? 'OK'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
