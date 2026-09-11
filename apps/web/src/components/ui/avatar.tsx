'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn, gradientFor, initialsOf } from '@/lib/utils';

const SIZES = {
  xs: 'h-7 w-7 text-[0.6rem]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-20 w-20 text-xl',
  '2xl': 'h-24 w-24 text-2xl',
  '3xl': 'h-32 w-32 text-4xl',
} as const;

export type AvatarSize = keyof typeof SIZES;

export interface UserAvatarProps {
  displayName: string;
  username?: string;
  avatarUrl?: string | null;
  size?: AvatarSize;
  /** Shows a presence dot when defined. */
  isOnline?: boolean;
  /** Wraps the avatar in the gradient story ring. */
  hasStory?: boolean;
  storySeen?: boolean;
  className?: string;
}

/**
 * Avatar with an initials fallback.
 *
 * The fallback gradient is derived from the username (or display name) so a
 * person without a picture still looks consistent everywhere in the app rather
 * than getting a random colour per render.
 */
export function UserAvatar({
  displayName,
  username,
  avatarUrl,
  size = 'md',
  isOnline,
  hasStory,
  storySeen,
  className,
}: UserAvatarProps) {
  const seed = username ?? displayName;
  const gradient = gradientFor(seed);

  const avatar = (
    <AvatarPrimitive.Root
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden rounded-full',
        SIZES[size],
        className,
      )}
    >
      {avatarUrl ? (
        <AvatarPrimitive.Image
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : null}
      <AvatarPrimitive.Fallback
        // No delay: a flash of empty circle looks broken in a chat list.
        delayMs={0}
        className={cn(
          'flex h-full w-full items-center justify-center bg-gradient-to-br font-semibold text-white',
          gradient,
        )}
      >
        {initialsOf(displayName)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );

  const withRing = hasStory ? (
    <span
      className={cn(
        'inline-flex rounded-full p-[2px]',
        storySeen ? 'bg-border' : 'bg-ring-gradient',
      )}
    >
      <span className="rounded-full bg-background p-[2px]">{avatar}</span>
    </span>
  ) : (
    avatar
  );

  if (isOnline === undefined) return withRing;

  return (
    <span className="relative inline-flex">
      {withRing}
      <span
        className={cn(
          'absolute bottom-0 right-0 rounded-full border-2 border-background transition-colors',
          size === 'xs' || size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3',
          isOnline ? 'bg-online' : 'bg-muted-foreground/50',
        )}
        // The dot is decorative; the textual presence label carries the meaning.
        aria-hidden
      />
    </span>
  );
}

export const Avatar = AvatarPrimitive.Root;
export const AvatarImage = AvatarPrimitive.Image;
export const AvatarFallback = AvatarPrimitive.Fallback;
