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
        'border-line text-ink flex min-h-[80px] w-full rounded-md border bg-white px-3.5 py-2.5 text-sm',
        'placeholder:text-ink-disabled transition-all duration-200',
        'focus-visible:border-brand-purple focus-visible:shadow-focus focus-visible:outline-none',
        'disabled:bg-bg-subtle disabled:text-ink-disabled disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    />
  );
});
