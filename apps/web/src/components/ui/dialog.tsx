'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
/** @public UI primitive API (shadcn set); not every part is used yet. */
export const DialogTrigger = DialogPrimitive.Trigger;
/** @public UI primitive API (shadcn set); not every part is used yet. */
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(function DialogContent({ className, children, hideClose, ...rest }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'bg-ink/20 fixed inset-0 z-40 backdrop-blur-[2px]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid w-full max-w-[440px] -translate-x-1/2 -translate-y-1/2 gap-4',
          'bg-bg-surface shadow-soft-lg rounded-xl p-8 outline-none',
          // Tall forms (Lead has 12+ fields) used to overflow the viewport
          // without scrolling. Cap height + scroll the content area; mobile
          // takes the full screen and scrolls vertically.
          'max-h-[90vh] overflow-y-auto',
          'max-sm:inset-0 max-sm:h-full max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...rest}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label="Close dialog"
            className="text-ink-muted hover:bg-bg-subtle hover:text-ink focus-visible:shadow-focus absolute right-4 top-4 rounded-md p-1.5 transition-all focus-visible:outline-none"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-1.5 text-left', className)}>{children}</div>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}>
      {children}
    </div>
  );
}
