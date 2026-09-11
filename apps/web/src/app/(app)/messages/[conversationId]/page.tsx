'use client';

import { useParams } from 'next/navigation';
import { MessageThread } from '@/features/messaging/MessageThread';

export default function ConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const conversationId = params?.conversationId;

  if (!conversationId) return null;
  // Keyed so switching conversations remounts the thread rather than leaking
  // scroll position and draft state between them.
  return <MessageThread key={conversationId} conversationId={conversationId} />;
}
