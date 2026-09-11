import { cn } from '@/lib/utils';

/**
 * The Sonder mark: an open circle (a person) crossed by two sound arcs (a voice
 * carrying to someone else). Drawn from scratch as SVG — original artwork, no
 * third-party brand assets anywhere in this project.
 */
export function SonderMark({
  className,
  gradient = true,
}: {
  className?: string;
  gradient?: boolean;
}) {
  const id = gradient ? 'sonder-mark-gradient' : undefined;
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={cn('size-8', className)}
    >
      {gradient ? (
        <defs>
          <linearGradient id={id} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
            <stop stopColor="hsl(266 85% 58%)" />
            <stop offset="0.55" stopColor="hsl(322 82% 58%)" />
            <stop offset="1" stopColor="hsl(28 92% 60%)" />
          </linearGradient>
        </defs>
      ) : null}
      <circle
        cx="12"
        cy="16"
        r="6.5"
        stroke={gradient ? `url(#${id})` : 'currentColor'}
        strokeWidth="2.4"
      />
      <path
        d="M21 11.2a7.4 7.4 0 0 1 0 9.6"
        stroke={gradient ? `url(#${id})` : 'currentColor'}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M25.4 7.6a12.6 12.6 0 0 1 0 16.8"
        stroke={gradient ? `url(#${id})` : 'currentColor'}
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export function SonderWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <SonderMark className="size-7" />
      <span className="font-display text-xl font-bold tracking-tight brand-text">
        Sonder
      </span>
    </span>
  );
}
