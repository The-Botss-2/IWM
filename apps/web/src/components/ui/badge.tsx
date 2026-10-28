import { cva, type VariantProps } from 'class-variance-authority';
import { type HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-bg-subtle text-ink',
        info: 'bg-bg-subtle text-brand-blue',
        success: 'border border-brand-teal/30 text-gradient-success',
        warning: 'bg-tint-warning text-brand-orange',
        danger: 'bg-tint-error text-state-error',
        brand: 'bg-brand-gradient text-white',
        gradient: 'bg-brand-gradient text-white',
        outline: 'border border-line text-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...rest }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...rest} />;
}
