'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import * as React from 'react';
import { SonderWordmark } from '@/components/brand';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { selectTotalUnread, useMessagingStore } from '@/store/messaging';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, PROFILE_NAV } from './nav-items';
import { isActive } from './Sidebar';
import { SearchPanel } from '@/features/users/SearchPanel';

/** Sticky top bar on phones. Hidden on desktop where the sidebar carries the brand. */
export function MobileTopBar() {
  const [searchOpen, setSearchOpen] = React.useState(false);
  const connected = useUiStore((state) => state.socketConnected);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border glass px-4 pt-safe md:hidden">
        <Link href="/" aria-label="Sonder home">
          <SonderWordmark className="scale-95" />
        </Link>
        <div className="flex items-center gap-1">
          {!connected ? (
            <span
              className="mr-1 flex items-center gap-1.5 rounded-full bg-signal-poor/10 px-2 py-1 text-[0.68rem] font-semibold text-signal-poor"
              role="status"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-signal-poor" aria-hidden />
              Offline
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
          >
            <Search aria-hidden />
          </Button>
        </div>
      </header>
      <SearchPanel open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

/**
 * Bottom tab bar. Five targets, each at least 48px tall, sitting above the home
 * indicator via the safe-area padding — the standard shape for one-handed use.
 */
export function MobileNav() {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const unread = useMessagingStore(selectTotalUnread);

  const items = NAV_ITEMS.filter((item) => item.mobile);
  const profileHref = user ? `/profile/${user.username}` : '/login';

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-30 border-t border-border glass pb-safe md:hidden"
    >
      <ul className="flex items-stretch justify-around">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                className="relative flex h-14 flex-col items-center justify-center gap-0.5"
              >
                <span className="relative">
                  <Icon
                    className={cn(
                      'size-6 transition-transform active:scale-90',
                      active ? 'stroke-[2.5]' : 'text-muted-foreground',
                    )}
                    aria-hidden
                  />
                  {item.badge === 'messages' && unread > 0 ? (
                    <span className="absolute -right-2 -top-1 flex min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[0.6rem] font-bold text-destructive-foreground">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <Link
            href={profileHref}
            aria-label="Profile"
            aria-current={pathname.startsWith('/profile') ? 'page' : undefined}
            className="flex h-14 items-center justify-center"
          >
            {user ? (
              <UserAvatar
                displayName={user.displayName}
                username={user.username}
                avatarUrl={user.avatarUrl}
                size="xs"
                className={cn(
                  pathname.startsWith('/profile') && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                )}
              />
            ) : (
              <PROFILE_NAV.icon className="size-6 text-muted-foreground" aria-hidden />
            )}
          </Link>
        </li>
      </ul>
    </nav>
  );
}
