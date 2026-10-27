import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-line bg-white px-3.5 py-2.5 text-sm text-ink',
        'placeholder:text-ink-disabled transition-all duration-200',
        'focus-visible:outline-none focus-visible:border-brand-purple focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-ink-disabled',
        className,
      )}
      {...rest}
    />
  );
});
