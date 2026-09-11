'use client';

import { AlertCircle, Check, CheckCheck, Clock } from 'lucide-react';
import type { MessageStatus } from '@sonder/shared';
import { cn } from '@/lib/utils';

const META: Record<MessageStatus, { label: string; className: string }> = {
  sending: { label: 'Sending', className: 'text-muted-foreground' },
  sent: { label: 'Sent', className: 'text-muted-foreground' },
  delivered: { label: 'Delivered', className: 'text-muted-foreground' },
  read: { label: 'Read', className: 'text-primary' },
  failed: { label: 'Failed to send', className: 'text-destructive' },
};

/**
 * Delivery state, drawn from the persisted message row rather than guessed:
 *   clock  = not yet acknowledged by the server
 *   tick   = stored, recipient offline
 *   ticks  = handed to the recipient's device
 *   ticks* = recipient opened the conversation
 */
export function MessageStatusIcon({
  status,
  className,
}: {
  status: MessageStatus;
  className?: string;
}) {
  const meta = META[status];
  const Icon =
    status === 'sending'
      ? Clock
      : status === 'failed'
        ? AlertCircle
        : status === 'sent'
          ? Check
          : CheckCheck;

  return (
    <span
      className={cn('inline-flex items-center', meta.className, className)}
      title={meta.label}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}
