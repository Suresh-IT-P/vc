'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth';
import { useMessagingStore } from '@/store/messaging';
import { useCallStore } from '@/store/call';
import { getSocket, onConnectionChange } from '@/lib/socket';
import { useUiStore } from '@/store/ui';

/**
 * The single place socket events are translated into store updates.
 *
 * Rendered once, high in the tree, and never unmounted while signed in — so a
 * page navigation cannot drop an incoming call or lose messages. It renders
 * nothing.
 */
export function RealtimeBridge() {
  const status = useAuthStore((state) => state.status);
  const currentUserId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (status !== 'authenticated' || !currentUserId) return;

    const socket = getSocket();
    const messaging = useMessagingStore.getState();
    const calls = useCallStore.getState();
    const ui = useUiStore.getState();

    /* ------------------------------ messaging ---------------------------- */

    const onMessage = (message: Parameters<typeof messaging.applyIncoming>[0]) => {
      useMessagingStore.getState().applyIncoming(message);

      // Notify only for messages from someone else, and only when the user is
      // not already looking at that thread.
      const state = useMessagingStore.getState();
      if (
        message.senderId !== currentUserId &&
        state.activeConversationId !== message.conversationId
      ) {
        const conversation = state.conversations.find(
          (item) => item.id === message.conversationId,
        );
        toast(conversation?.peer.displayName ?? 'New message', {
          description: message.body.slice(0, 120),
        });
      }
    };

    const onDelivered = (payload: Parameters<typeof messaging.applyDelivered>[0]) =>
      useMessagingStore.getState().applyDelivered(payload);
    const onRead = (payload: Parameters<typeof messaging.applyRead>[0]) =>
      useMessagingStore.getState().applyRead(payload);
    const onTypingStart = (payload: Parameters<typeof messaging.applyTyping>[0]) =>
      useMessagingStore.getState().applyTyping({ ...payload, isTyping: true });
    const onTypingStop = (payload: Parameters<typeof messaging.applyTyping>[0]) =>
      useMessagingStore.getState().applyTyping({ ...payload, isTyping: false });
    const onConversation = (payload: Parameters<typeof messaging.applyConversation>[0]) =>
      useMessagingStore.getState().applyConversation(payload);

    /* ------------------------------ presence ----------------------------- */

    const onOnline = (payload: Parameters<typeof messaging.applyPresence>[0]) =>
      useMessagingStore.getState().applyPresence(payload);
    const onOffline = (payload: Parameters<typeof messaging.applyPresence>[0]) =>
      useMessagingStore.getState().applyPresence(payload);

    /* ------------------------------- calling ----------------------------- */

    const onIncoming = (call: Parameters<typeof calls.handleIncoming>[0]) => {
      useCallStore.getState().handleIncoming(call);
    };
    const onRinging = () => useCallStore.getState().handleRinging();
    const onAccepted = () => void useCallStore.getState().handleAccepted();
    const onRejected = (payload: { reason: 'REJECTED' | 'BUSY' }) =>
      useCallStore.getState().handleRejected(payload.reason);
    const onEnded = (payload: Parameters<typeof calls.handleEnded>[0]) =>
      useCallStore.getState().handleEnded(payload);
    const onCallFailed = (payload: Parameters<typeof calls.handleFailed>[0]) =>
      useCallStore.getState().handleFailed(payload);
    const onReconnecting = () => useCallStore.getState().handleReconnecting();
    const onPeerVoice = (payload: {
      enabled: boolean;
      preset: string | null;
    }) => {
      // Transparency: the far end is told when the other side is transforming
      // their voice. This is deliberate and not configurable.
      useUiStore.getState().setPeerVoiceState(payload.enabled);
    };

    const onOffer = (payload: Parameters<typeof calls.handleRemoteOffer>[0]) =>
      void useCallStore.getState().handleRemoteOffer(payload);
    const onAnswer = (payload: Parameters<typeof calls.handleRemoteAnswer>[0]) =>
      void useCallStore.getState().handleRemoteAnswer(payload);
    const onCandidate = (payload: Parameters<typeof calls.handleRemoteCandidate>[0]) =>
      void useCallStore.getState().handleRemoteCandidate(payload);

    const onServerError = (payload: { code: string; message: string }) => {
      toast.error(payload.message);
    };

    socket.on('message:new', onMessage);
    socket.on('message:delivered', onDelivered);
    socket.on('message:read', onRead);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('conversation:created', onConversation);
    socket.on('user:online', onOnline);
    socket.on('user:offline', onOffline);
    socket.on('call:incoming', onIncoming);
    socket.on('call:ringing', onRinging);
    socket.on('call:accepted', onAccepted);
    socket.on('call:rejected', onRejected);
    socket.on('call:ended', onEnded);
    socket.on('call:failed', onCallFailed);
    socket.on('call:reconnecting', onReconnecting);
    socket.on('call:peer-voice', onPeerVoice);
    socket.on('webrtc:offer', onOffer);
    socket.on('webrtc:answer', onAnswer);
    socket.on('webrtc:ice-candidate', onCandidate);
    socket.on('error', onServerError);

    const unsubscribeConnection = onConnectionChange((connected) => {
      useUiStore.getState().setSocketConnected(connected);
      if (connected) {
        // Resync anything that could have changed while we were away.
        void useMessagingStore.getState().loadConversations();
      }
    });

    void useMessagingStore.getState().loadConversations();

    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:delivered', onDelivered);
      socket.off('message:read', onRead);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('conversation:created', onConversation);
      socket.off('user:online', onOnline);
      socket.off('user:offline', onOffline);
      socket.off('call:incoming', onIncoming);
      socket.off('call:ringing', onRinging);
      socket.off('call:accepted', onAccepted);
      socket.off('call:rejected', onRejected);
      socket.off('call:ended', onEnded);
      socket.off('call:failed', onCallFailed);
      socket.off('call:reconnecting', onReconnecting);
      socket.off('call:peer-voice', onPeerVoice);
      socket.off('webrtc:offer', onOffer);
      socket.off('webrtc:answer', onAnswer);
      socket.off('webrtc:ice-candidate', onCandidate);
      socket.off('error', onServerError);
      unsubscribeConnection();
      ui.setSocketConnected(false);
    };
  }, [status, currentUserId]);

  return null;
}
