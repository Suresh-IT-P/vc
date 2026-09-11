'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // Minimum 40px tall by default: comfortably tappable on a phone without
  // feeling oversized on desktop.
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] select-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        brand:
          'bg-brand-gradient text-white shadow-sm hover:brightness-110 hover:shadow-glow',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        outline:
          'border border-border bg-transparent hover:bg-secondary/60',
        ghost: 'hover:bg-secondary/70',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        success:
          'bg-signal-excellent text-white shadow-sm hover:brightness-110',
        link: 'text-primary underline-offset-4 hover:underline rounded-md',
      },
      size: {
        default: 'h-10 px-5 [&_svg]:size-4',
        sm: 'h-8 px-3.5 text-xs [&_svg]:size-3.5',
        lg: 'h-12 px-7 text-base [&_svg]:size-5',
        icon: 'h-10 w-10 [&_svg]:size-[1.15rem]',
        'icon-sm': 'h-8 w-8 [&_svg]:size-4',
        'icon-lg': 'h-14 w-14 [&_svg]:size-6',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, children, disabled, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        // Screen readers should know the control is busy, not just visually spinning.
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" aria-hidden />
            {size !== 'icon' && size !== 'icon-sm' && size !== 'icon-lg' ? children : null}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
