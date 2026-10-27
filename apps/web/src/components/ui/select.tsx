'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '@/lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex h-10 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-line bg-white px-3.5 py-2.5 text-left text-sm text-ink',
        // Label never wraps: icons keep their size and the value span
        // ellipsizes if a caller pins the trigger narrower than its text.
        '[&_svg]:shrink-0 [&>span]:min-w-0 [&>span]:truncate',
        'transition-all duration-200',
        'focus-visible:outline-none focus-visible:border-brand-purple focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-ink-disabled',
        'data-[placeholder]:text-ink-disabled',
        className,
      )}
      {...rest}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...rest }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          'relative z-50 max-h-72 min-w-[8rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-line bg-white shadow-popover',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          position === 'popper' && 'data-[side=bottom]:translate-y-1',
          className,
        )}
        {...rest}
      >
        <SelectPrimitive.Viewport
          className={cn(
            'p-1.5',
            // At least as wide as the trigger, but free to grow to fit the
            // longest option (a fixed trigger width broke labels mid-word).
            position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)]',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-ink outline-none transition-colors',
        'data-[highlighted]:bg-bg-subtle data-[highlighted]:text-ink',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...rest}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-3.5 w-3.5 text-brand-purple" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 truncate">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
    </SelectPrimitive.Item>
  );
});
