'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '@/lib/utils';

export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...rest }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn('text-ink text-[13px] font-medium leading-none', className)}
      {...rest}
    />
  );
});
