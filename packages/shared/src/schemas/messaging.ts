import { z } from 'zod';

export const MESSAGE_MAX_LENGTH = 4000;

export const cuidLike = z.string().trim().min(1).max(64);

export const searchUsersSchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const createConversationSchema = z.object({
  /** The other participant. Server derives the current user from the token. */
  userId: cuidLike,
});

export const sendMessageSchema = z.object({
  conversationId: cuidLike,
  body: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(MESSAGE_MAX_LENGTH, `Message must be under ${MESSAGE_MAX_LENGTH} characters`)
    .refine((v) => v.trim().length > 0, 'Message cannot be only whitespace'),
  /** Client-generated idempotency key; makes retries safe. */
  clientId: z.string().trim().min(1).max(64),
});

export const listMessagesSchema = z.object({
  conversationId: cuidLike,
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export const markReadSchema = z.object({
  conversationId: cuidLike,
  /** Everything up to and including this message becomes read. */
  messageId: cuidLike.optional(),
});

export const typingSchema = z.object({
  conversationId: cuidLike,
});

export const searchMessagesSchema = z.object({
  q: z.string().trim().min(1).max(128),
  conversationId: cuidLike.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
