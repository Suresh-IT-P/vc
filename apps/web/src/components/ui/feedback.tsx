'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/* --------------------------------- Badge --------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/12 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        success: 'border-transparent bg-signal-excellent/15 text-signal-excellent',
        warning: 'border-transparent bg-signal-poor/15 text-signal-poor',
        destructive: 'border-transparent bg-destructive/12 text-destructive',
        /** Marks seeded / non-functional demo content. */
        demo: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/* -------------------------------- Skeleton -------------------------------- */

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton rounded-lg', className)} {...props} />;
}

/* -------------------------------- Spinner --------------------------------- */

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className={label ? 'text-sm text-muted-foreground' : 'sr-only'}>
        {label ?? 'Loading'}
      </span>
    </span>
  );
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}

/* ------------------------------- EmptyState ------------------------------- */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-16 items-center justify-center rounded-full bg-brand-gradient-soft">
          <Icon className="size-7 text-primary" aria-hidden />
        </span>
      ) : null}
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------- ErrorState ------------------------------- */

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
      </span>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        {message ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------- Separator -------------------------------- */

export function Separator({
  className,
  orientation = 'horizontal',
}: {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}

/**
 * Labels a feature that is intentionally demo-only, so nobody mistakes seeded
 * content for a working backend. See docs/architecture.md.
 */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge variant="demo" className={cn('gap-1', className)} title="Seeded sample content">
      Demo
    </Badge>
  );
}
