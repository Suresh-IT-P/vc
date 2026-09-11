'use client';

import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/feedback';

/**
 * Desktop-only placeholder. On mobile this route renders just the conversation
 * list (the layout hides this pane), so there is nothing to show here.
 */
export default function MessagesIndexPage() {
  return (
    <div className="hidden h-full items-center justify-center md:flex">
      <EmptyState
        icon={MessagesSquare}
        title="Your messages"
        description="Pick a conversation, or search for someone to start a new one."
      />
    </div>
  );
}
