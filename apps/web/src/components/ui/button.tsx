import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium ' +
    // Icons never get squeezed by the label.
    '[&_svg]:shrink-0 ' +
    'transition-all duration-200 focus-visible:outline-none ' +
    'focus-visible:shadow-focus focus-visible:border-brand-purple ' +
    'disabled:opacity-50 disabled:pointer-events-none ' +
    'active:scale-[0.98] min-h-[40px]',
  {
    variants: {
      variant: {
        // New brand gradient primary - pill, white text, soft shadow.
        primary: 'bg-brand-gradient text-white shadow-soft hover:shadow-soft-lg',
        gradient: 'bg-brand-gradient text-white shadow-soft hover:shadow-soft-lg',
        secondary:
          'border border-line bg-white text-ink hover:bg-bg-subtle ' +
          'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
        // Dark variant carries explicit text + hover-bg colors so ghost icon
        // buttons (chat header Phone / Info, etc.) remain legible on dark
        // surfaces instead of disappearing into the background until hover.
        ghost: 'text-ink hover:bg-bg-subtle ' + 'dark:text-slate-100 dark:hover:bg-slate-700',
        destructive: 'bg-[#E5484D] text-white hover:bg-[#D03B40] shadow-soft',
        outline:
          'border border-line bg-transparent text-ink hover:bg-bg-subtle ' +
          'dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-700',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs min-h-[32px]',
        md: 'px-5 py-2',
        lg: 'px-6 py-2.5 text-base',
        icon: 'h-10 w-10 p-0 min-h-[40px] min-w-[40px]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, type = 'button', ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
});
