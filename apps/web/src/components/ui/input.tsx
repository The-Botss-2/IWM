import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-line bg-white px-3.5 py-2.5 text-sm text-ink',
        'placeholder:text-ink-disabled transition-all duration-200',
        'focus-visible:outline-none focus-visible:border-brand-purple focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-ink-disabled',
        className,
      )}
      {...rest}
    />
  );
});
