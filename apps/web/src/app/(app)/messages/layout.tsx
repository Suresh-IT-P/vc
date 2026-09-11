'use client';

import { usePathname } from 'next/navigation';
import { ConversationList } from '@/features/messaging/ConversationList';
import { cn } from '@/lib/utils';

/**
 * Two-pane inbox.
 *
 * Desktop keeps the conversation list permanently visible beside the thread.
 * Mobile shows one pane at a time — list at /messages, thread at /messages/[id] —
 * which is what makes the chat usable one-handed without a nested scroll trap.
 */
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const threadOpen = /^\/messages\/[^/]+/.test(pathname);

  return (
    <div className="flex h-full overflow-hidden" style={{ height: 'var(--app-height)' }}>
      <aside
        className={cn(
          'flex min-h-0 w-full flex-col border-r border-border md:w-[21rem] md:shrink-0 xl:w-[24rem]',
          threadOpen && 'hidden md:flex',
        )}
        aria-label="Conversations"
      >
        <ConversationList />
      </aside>

      <section
        className={cn('min-w-0 flex-1 flex-col', threadOpen ? 'flex' : 'hidden md:flex')}
      >
        {children}
      </section>
    </div>
  );
}
