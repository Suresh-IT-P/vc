'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { CallPeer, PublicUser } from '@sonder/shared';
import { useMessagingStore } from '@/store/messaging';
import { useCallStore } from '@/store/call';

export interface UserActionTarget {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * The two actions that must never be fake: opening the real chat, and placing
 * the real call. Shared by search results, the profile header and the chat
 * header so all three go through exactly the same code.
 */
export function useUserActions() {
  const router = useRouter();
  const startConversationWith = useMessagingStore((state) => state.startConversationWith);
  const startCall = useCallStore((state) => state.startCall);
  const callState = useCallStore((state) => state.state);

  const [busy, setBusy] = useState<'message' | 'call' | null>(null);

  const openChat = useCallback(
    async (user: UserActionTarget) => {
      setBusy('message');
      try {
        // Creates the conversation if it does not exist yet; idempotent.
        const conversationId = await startConversationWith(user.id);
        router.push(`/messages/${conversationId}`);
        return conversationId;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Could not open that conversation.',
        );
        return null;
      } finally {
        setBusy(null);
      }
    },
    [router, startConversationWith],
  );

  const call = useCallback(
    async (user: UserActionTarget, options: { conversationId?: string } = {}) => {
      if (callState !== 'IDLE') {
        toast.error('You are already on a call.');
        return;
      }
      setBusy('call');
      try {
        const peer: CallPeer = {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        };
        await startCall(peer, options);
      } finally {
        setBusy(null);
      }
    },
    [callState, startCall],
  );

  return { openChat, call, busy, callInProgress: callState !== 'IDLE' };
}

export function toActionTarget(user: PublicUser): UserActionTarget {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}
