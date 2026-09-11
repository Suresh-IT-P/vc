'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Menu, Moon, Search, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { SonderMark, SonderWordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/controls';
import { useAuthStore } from '@/store/auth';
import { selectTotalUnread, useMessagingStore } from '@/store/messaging';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, SECONDARY_NAV_ITEMS, PROFILE_NAV } from './nav-items';
import { SearchPanel } from '@/features/users/SearchPanel';

/** Desktop left rail. Collapses to icons on medium screens. */
export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const unread = useMessagingStore(selectTotalUnread);
  const connected = useUiStore((state) => state.socketConnected);
  const { resolvedTheme, setTheme } = useTheme();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const profileHref = user ? `/profile/${user.username}` : '/login';

  return (
    <>
      <aside className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-background px-3 py-6 md:flex md:w-[76px] xl:w-64 xl:px-4">
        <Link
          href="/"
          className="mb-8 flex items-center px-2 xl:px-1"
          aria-label="Sonder home"
        >
          <span className="hidden xl:block">
            <SonderWordmark />
          </span>
          <span className="xl:hidden">
            <SonderMark />
          </span>
        </Link>

        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          <SidebarButton
            icon={Search}
            label="Search"
            onClick={() => setSearchOpen(true)}
          />

          {NAV_ITEMS.map((item) => (
            <SidebarLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(pathname, item.href)}
              badge={item.badge === 'messages' && unread > 0 ? unread : undefined}
            />
          ))}

          <SidebarLink
            href={profileHref}
            label={PROFILE_NAV.label}
            icon={PROFILE_NAV.icon}
            active={pathname.startsWith('/profile')}
            avatar={
              user ? (
                <UserAvatar
                  displayName={user.displayName}
                  username={user.username}
                  avatarUrl={user.avatarUrl}
                  size="xs"
                />
              ) : undefined
            }
          />
        </nav>

        <div className="flex flex-col gap-1 pt-4">
          {/* Connection state is shown plainly: if the socket is down, messages
              and calls will not work, and pretending otherwise helps nobody. */}
          <div
            className={cn(
              'mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium',
              connected
                ? 'text-muted-foreground'
                : 'bg-signal-poor/10 text-signal-poor',
            )}
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                connected ? 'bg-online' : 'bg-signal-poor animate-pulse',
              )}
              aria-hidden
            />
            <span className="hidden xl:inline">
              {connected ? 'Connected' : 'Reconnecting…'}
            </span>
          </div>

          {SECONDARY_NAV_ITEMS.map((item) => (
            <SidebarLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(pathname, item.href)}
            />
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors hover:bg-secondary"
              >
                <Menu className="size-6 shrink-0" aria-hidden />
                <span className="hidden xl:inline">More</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-56">
              <DropdownMenuItem
                onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              >
                {mounted && resolvedTheme === 'dark' ? (
                  <Sun className="size-4" aria-hidden />
                ) : (
                  <Moon className="size-4" aria-hidden />
                )}
                Switch appearance
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => void logout()}>
                <LogOut className="size-4" aria-hidden />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <SearchPanel open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
  badge,
  avatar,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  badge?: number;
  avatar?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
        active ? 'font-semibold' : 'font-medium',
        'hover:bg-secondary',
      )}
      title={label}
    >
      <span className="relative shrink-0">
        {avatar ?? (
          <Icon
            className={cn(
              'size-6 transition-transform group-hover:scale-105',
              active && 'stroke-[2.5]',
            )}
          />
        )}
        {badge ? (
          <span className="absolute -right-1.5 -top-1 flex min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[0.62rem] font-bold text-destructive-foreground">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
      <span className="hidden xl:inline">{label}</span>
    </Link>
  );
}

function SidebarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors hover:bg-secondary"
    >
      <Icon className="size-6 shrink-0 transition-transform group-hover:scale-105" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
