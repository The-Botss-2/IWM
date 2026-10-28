'use client';

import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Password field with a built-in show/hide toggle. Mirrors the styling of the
 * `.input` utility so it can drop into existing auth forms without layout
 * shifts. The toggle button is keyboard-focusable and announced with
 * `aria-label`/`aria-pressed` so assistive tech describes both states.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...rest }, ref) {
    const [revealed, setRevealed] = useState(false);
    return (
      <div className="relative">
        <input
          ref={ref}
          type={revealed ? 'text' : 'password'}
          className={cn('input pr-10', className)}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          tabIndex={0}
          aria-pressed={revealed}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          className={cn(
            'absolute inset-y-0 right-0 flex w-10 items-center justify-center',
            'text-ink-muted hover:text-ink focus-visible:text-ink',
            'focus-visible:shadow-focus rounded-r-md focus-visible:outline-none',
          )}
        >
          {revealed ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    );
  },
);
