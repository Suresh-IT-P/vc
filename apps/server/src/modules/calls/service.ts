import type {
  CallEndReason,
  CallHistoryEntry,
  Paginated,
  ServerCallState,
  VoicePresetId,
} from '@sonder/shared';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { toCallPeer } from '../../lib/serialize.js';

const PEER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  isOnline: true,
  lastSeenAt: true,
} as const;

export async function createCallRow(input: {
  callerId: string;
  calleeId: string;
  conversationId: string | null;
}) {
  return prisma.call.create({
    data: {
      callerId: input.callerId,
      calleeId: input.calleeId,
      conversationId: input.conversationId,
      type: 'AUDIO',
      status: 'RINGING',
      participants: {
        create: [
          { userId: input.callerId, role: 'CALLER' },
          { userId: input.calleeId, role: 'CALLEE' },
        ],
      },
    },
    include: {
      caller: { select: PEER_SELECT },
      callee: { select: PEER_SELECT },
    },
  });
}

export async function setCallState(callId: string, state: ServerCallState, at = new Date()) {
  await prisma.call.update({
    where: { id: callId },
    data: {
      status: state,
      ...(state === 'ACCEPTED' ? { answeredAt: at } : {}),
    },
  });
}

export async function finaliseCall(input: {
  callId: string;
  reason: CallEndReason;
  endedById: string | null;
  answeredAt: Date | null;
  endedAt?: Date;
  reconnectCount?: number;
}) {
  const endedAt = input.endedAt ?? new Date();
  const durationSec = input.answeredAt
    ? Math.max(0, Math.round((endedAt.getTime() - input.answeredAt.getTime()) / 1000))
    : 0;

  await prisma.call.update({
    where: { id: input.callId },
    data: {
      status: 'ENDED',
      endReason: input.reason,
      endedAt,
      endedById: input.endedById,
      durationSec,
      ...(input.reconnectCount !== undefined ? { reconnectCount: input.reconnectCount } : {}),
    },
  });

  await prisma.callParticipant.updateMany({
    where: { callId: input.callId, leftAt: null },
    data: { leftAt: endedAt },
  });

  return { durationSec, endedAt };
}

/**
 * Records what the *user themselves* did with the voice changer. This is
 * reported, never enforced: the server has no way to inspect the encrypted
 * media, so history shows the caller's own client's claim about its own audio.
 */
export async function recordVoiceUsage(
  callId: string,
  userId: string,
  enabled: boolean,
  preset: VoicePresetId | null,
) {
  await prisma.callParticipant.updateMany({
    where: { callId, userId },
    data: {
      // Sticky: once the changer was on during a call, the history says so even
      // if it was switched off before hanging up.
      ...(enabled ? { voiceChangerUsed: true, voicePreset: preset } : {}),
    },
  });
}

export async function recordQuality(callId: string, userId: string, level: string) {
  await prisma.callParticipant.updateMany({
    where: { callId, userId },
    data: { lastQuality: level.slice(0, 20) },
  });
}

function historyStatus(
  row: { status: string; endReason: string | null; answeredAt: Date | null },
  viewerIsCaller: boolean,
): CallHistoryEntry['status'] {
  if (row.answeredAt && (row.endReason === 'COMPLETED' || row.endReason === null)) {
    return 'completed';
  }
  switch (row.endReason) {
    case 'REJECTED':
      return 'rejected';
    case 'CANCELLED':
      return viewerIsCaller ? 'cancelled' : 'missed';
    case 'TIMEOUT':
    case 'UNAVAILABLE':
    case 'BUSY':
      return viewerIsCaller ? 'cancelled' : 'missed';
    case 'FAILED':
      return 'failed';
    default:
      return row.answeredAt ? 'completed' : 'missed';
  }
}

export async function listCallHistory(
  viewerId: string,
  options: { cursor?: string; limit: number },
): Promise<Paginated<CallHistoryEntry>> {
  const rows = await prisma.call.findMany({
    where: {
      OR: [{ callerId: viewerId }, { calleeId: viewerId }],
      status: 'ENDED',
    },
    include: {
      caller: { select: PEER_SELECT },
      callee: { select: PEER_SELECT },
      participants: {
        where: { userId: viewerId },
        select: { voiceChangerUsed: true, voicePreset: true },
      },
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  const items: CallHistoryEntry[] = page.map((row) => {
    const viewerIsCaller = row.callerId === viewerId;
    const mine = row.participants[0];
    return {
      id: row.id,
      peer: toCallPeer(viewerIsCaller ? row.callee : row.caller),
      direction: viewerIsCaller ? 'outgoing' : 'incoming',
      type: 'audio',
      status: historyStatus(row, viewerIsCaller),
      endReason: (row.endReason as CallEndReason | null) ?? null,
      startedAt: row.startedAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      durationSec: row.durationSec,
      voiceChangerUsed: mine?.voiceChangerUsed ?? false,
      voicePreset: mine?.voicePreset ?? null,
    };
  });

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getCallForUser(callId: string, viewerId: string) {
  const row = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      caller: { select: PEER_SELECT },
      callee: { select: PEER_SELECT },
    },
  });
  if (!row || (row.callerId !== viewerId && row.calleeId !== viewerId)) {
    throw notFound('That call does not exist.');
  }
  return row;
}

/**
 * Any call still marked live at boot is a leftover from a crash: no in-memory
 * registry entry exists for it, so it can never be ended by a client.
 */
export async function reapOrphanedCalls(): Promise<number> {
  const result = await prisma.call.updateMany({
    where: { status: { in: ['RINGING', 'ACCEPTED', 'CONNECTED'] } },
    data: { status: 'ENDED', endReason: 'FAILED', endedAt: new Date() },
  });
  return result.count;
}
