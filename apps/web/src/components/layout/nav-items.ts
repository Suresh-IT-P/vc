import {
  Bell,
  Bookmark,
  Compass,
  Home,
  MessageCircle,
  Phone,
  Play,
  Settings,
  User,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shows the unread-messages count. */
  badge?: 'messages';
  /** Feature tier, used to mark demo-only sections in the UI. */
  tier: 'real' | 'demo';
  /** Present in the mobile bottom bar. */
  mobile?: boolean;
}

/**
 * `tier` is not decoration: sections marked `demo` are seeded content with no
 * real backend behind them, and the UI says so rather than implying otherwise.
 * Everything in the `real` tier is fully functional.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: Home, tier: 'demo', mobile: true },
  { href: '/explore', label: 'Explore', icon: Compass, tier: 'demo', mobile: true },
  { href: '/reels', label: 'Reels', icon: Play, tier: 'demo', mobile: true },
  {
    href: '/messages',
    label: 'Messages',
    icon: MessageCircle,
    badge: 'messages',
    tier: 'real',
    mobile: true,
  },
  { href: '/calls', label: 'Calls', icon: Phone, tier: 'real' },
  { href: '/notifications', label: 'Notifications', icon: Bell, tier: 'demo' },
];

export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: '/saved', label: 'Saved', icon: Bookmark, tier: 'demo' },
  { href: '/settings', label: 'Settings', icon: Settings, tier: 'real' },
];

export const PROFILE_NAV: Omit<NavItem, 'href'> = {
  label: 'Profile',
  icon: User,
  tier: 'real',
  mobile: true,
};
