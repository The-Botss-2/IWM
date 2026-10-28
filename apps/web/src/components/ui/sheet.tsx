'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export const Sheet = DialogPrimitive.Root;
/** @public UI primitive API (shadcn set); not every part is used yet. */
export const SheetTrigger = DialogPrimitive.Trigger;
/** @public UI primitive API (shadcn set); not every part is used yet. */
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

const SheetOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function SheetOverlay({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'bg-ink/20 fixed inset-0 z-40 backdrop-blur-[2px]',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150',
        className,
      )}
      {...rest}
    />
  );
});

interface SheetContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: 'right' | 'left' | 'top' | 'bottom';
}

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent({ className, side = 'right', children, ...rest }, ref) {
  const sideStyles: Record<string, string> = {
    right:
      'inset-y-0 right-0 h-full w-full sm:max-w-[480px] rounded-l-xl shadow-drawer ' +
      'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-200 ' +
      'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-150',
    left:
      'inset-y-0 left-0 h-full w-full sm:max-w-[480px] rounded-r-xl shadow-soft-lg ' +
      'data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=open]:duration-200 ' +
      'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=closed]:duration-150',
    top:
      'inset-x-0 top-0 w-full rounded-b-xl shadow-soft-lg ' +
      'data-[state=open]:animate-in data-[state=open]:slide-in-from-top data-[state=open]:duration-200 ' +
      'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top data-[state=closed]:duration-150',
    bottom:
      'inset-x-0 bottom-0 w-full max-h-[90vh] rounded-t-xl shadow-soft-lg ' +
      'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=open]:duration-200 ' +
      'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=closed]:duration-150',
  };
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex flex-col bg-white outline-none',
          sideStyles[side],
          className,
        )}
        {...rest}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close panel"
          className="text-ink-muted hover:bg-bg-subtle hover:text-ink focus-visible:shadow-focus absolute right-4 top-4 rounded-md p-1.5 transition-all focus-visible:outline-none"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function SheetHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-line flex flex-col gap-1 border-b p-6 pr-12', className)}>
      {children}
    </div>
  );
}

export function SheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex-1 overflow-y-auto p-6', className)}>{children}</div>;
}

export function SheetFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'border-line flex flex-wrap items-center justify-end gap-2 border-t p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
