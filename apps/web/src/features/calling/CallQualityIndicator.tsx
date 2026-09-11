'use client';

import type { CallQuality } from '@sonder/shared';
import { cn } from '@/lib/utils';

const LEVEL_META: Record<
  CallQuality['level'],
  { bars: number; colour: string; label: string }
> = {
  excellent: { bars: 4, colour: 'bg-signal-excellent', label: 'Excellent connection' },
  good: { bars: 3, colour: 'bg-signal-good', label: 'Good connection' },
  poor: { bars: 2, colour: 'bg-signal-poor', label: 'Weak connection' },
  critical: { bars: 1, colour: 'bg-signal-critical', label: 'Very weak connection' },
  unknown: { bars: 0, colour: 'bg-muted-foreground/40', label: 'Measuring connection' },
};

/**
 * Signal bars driven by real RTCStatsReport numbers (RTT, jitter, packet loss),
 * not a decoration. The tooltip shows the raw figures so a user reporting a bad
 * call can say something specific.
 */
export function CallQualityIndicator({
  quality,
  className,
  showDetail = false,
}: {
  quality: CallQuality | null;
  className?: string;
  showDetail?: boolean;
}) {
  const level = quality?.level ?? 'unknown';
  const meta = LEVEL_META[level];

  const detail = quality
    ? [
        quality.rttMs !== null ? `${quality.rttMs} ms round trip` : null,
        quality.jitterMs !== null ? `${quality.jitterMs} ms jitter` : null,
        quality.packetsLostPct !== null
          ? `${quality.packetsLostPct.toFixed(1)}% packet loss`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <span
      className={cn('inline-flex items-center gap-2', className)}
      title={detail || meta.label}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={cn(
              'w-[3px] rounded-full transition-colors',
              bar === 1 && 'h-1.5',
              bar === 2 && 'h-2.5',
              bar === 3 && 'h-3.5',
              bar === 4 && 'h-[18px]',
              bar <= meta.bars ? meta.colour : 'bg-current opacity-25',
            )}
          />
        ))}
      </span>
      <span className="sr-only">{meta.label}</span>
      {showDetail && detail ? (
        <span className="tabular text-xs text-current opacity-70">{detail}</span>
      ) : null}
    </span>
  );
}
