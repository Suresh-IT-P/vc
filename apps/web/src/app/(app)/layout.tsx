'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileNav, MobileTopBar } from '@/components/layout/MobileNav';
import { FullPageSpinner } from '@/components/ui/feedback';
import { useAuthStore } from '@/store/auth';

/**
 * Authenticated shell. Everything inside requires a session; the server enforces
 * this too, so this guard is about UX (no flash of an empty feed), not security.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      // Preserve where they were headed so login can send them back.
      const next = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
    }
  }, [status, router, pathname]);

  if (status === 'loading') {
    return (
      <div className="app-shell flex items-center justify-center">
        <FullPageSpinner label="Loading Sonder" />
      </div>
    );
  }

  if (status === 'anonymous') return null;

  // The chat thread and reels manage their own scrolling and must fill the
  // viewport exactly, so the shell does not add page scroll for them.
  const isImmersive =
    pathname.startsWith('/messages/') || pathname.startsWith('/reels');

  return (
    <div className="app-shell flex flex-col md:flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {!isImmersive ? <MobileTopBar /> : null}
        <main
          className={
            isImmersive
              ? 'min-w-0 flex-1 overflow-hidden'
              : 'min-w-0 flex-1'
          }
        >
          {children}
        </main>
        {!isImmersive ? <MobileNav /> : null}
      </div>
    </div>
  );
}
