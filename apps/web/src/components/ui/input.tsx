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
        'border-line text-ink flex h-10 w-full rounded-md border bg-white px-3.5 py-2.5 text-sm',
        'placeholder:text-ink-disabled transition-all duration-200',
        'focus-visible:border-brand-purple focus-visible:shadow-focus focus-visible:outline-none',
        'disabled:bg-bg-subtle disabled:text-ink-disabled disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    />
  );
});
