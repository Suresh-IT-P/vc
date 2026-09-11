export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  status: MessageStatus;
  /** ISO timestamps, absent until the event happens. */
  deliveredAt: string | null;
  readAt: string | null;
  /** Echoed back so the sender can reconcile its optimistic message. */
  clientId?: string;
}

export interface ConversationParticipant {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  lastReadAt: string | null;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The *other* participant in a 1:1 conversation. */
  peer: ConversationParticipant;
  lastMessage: Message | null;
  unreadCount: number;
}

export interface TypingState {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next (older) page; null when exhausted. */
  nextCursor: string | null;
}
