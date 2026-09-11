import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AVATAR_FALLBACK_GRADIENTS } from '@sonder/shared';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "3:07" or "1:02:33" — used for live call duration. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Compact relative time, Instagram-style: 12s, 4m, 3h, 2d, 5w. */
export function formatRelative(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(weeks / 52)}y`;
}

/** "14:32" in the viewer's locale. */
export function formatClockTime(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Day heading for message and call lists. */
export function formatDayLabel(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';

  const withinWeek = Date.now() - date.getTime() < 6 * 86_400_000;
  if (withinWeek) return date.toLocaleDateString(undefined, { weekday: 'long' });

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "Active now" / "Active 12m ago" / "Offline". */
export function formatPresence(isOnline: boolean, lastSeenAt: string | null): string {
  if (isOnline) return 'Active now';
  if (!lastSeenAt) return 'Offline';
  return `Active ${formatRelative(lastSeenAt)} ago`;
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}K`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}M`;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** Stable per-user gradient, so an avatarless user always looks the same. */
export function gradientFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_FALLBACK_GRADIENTS.length;
  return AVATAR_FALLBACK_GRADIENTS[index];
}

/** Client-side idempotency key for message sends. */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Groups a chronological list into day buckets, preserving order. */
export function groupByDay<T>(
  items: T[],
  getDate: (item: T) => string,
): Array<{ label: string; items: T[] }> {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = formatDayLabel(getDate(item));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
