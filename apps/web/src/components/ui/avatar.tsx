'use client';

import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '@/lib/utils';

const Avatar = forwardRef<
  ElementRef<typeof AvatarPrimitive.Root>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(function Avatar({ className, ...rest }, ref) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(
        'bg-bg-subtle relative inline-flex h-9 w-9 shrink-0 overflow-hidden rounded-full',
        className,
      )}
      {...rest}
    />
  );
});

const AvatarImage = forwardRef<
  ElementRef<typeof AvatarPrimitive.Image>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(function AvatarImage({ className, ...rest }, ref) {
  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn('aspect-square h-full w-full object-cover', className)}
      {...rest}
    />
  );
});

const AvatarFallback = forwardRef<
  ElementRef<typeof AvatarPrimitive.Fallback>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(function AvatarFallback({ className, ...rest }, ref) {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        'bg-fallback-avatar flex h-full w-full items-center justify-center text-xs font-semibold uppercase text-white',
        className,
      )}
      {...rest}
    />
  );
});

export function UserAvatar({
  name,
  image,
  size = 'md',
  className,
  online = false,
}: {
  name: string;
  image?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  online?: boolean;
}) {
  const sizes = {
    xs: 'h-5 w-5 text-[9px]',
    sm: 'h-7 w-7 text-[10px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-12 w-12 text-sm',
    xl: 'h-[72px] w-[72px] text-base',
  };
  return (
    <span className="relative inline-block">
      <Avatar className={cn(sizes[size], className)}>
        {image ? <AvatarImage src={image} alt={`${name} avatar`} /> : null}
        <AvatarFallback>{name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      {online ? (
        <span
          aria-hidden
          className="bg-brand-teal absolute bottom-0 right-0 h-2 w-2 rounded-full ring-2 ring-white"
        />
      ) : null}
    </span>
  );
}
