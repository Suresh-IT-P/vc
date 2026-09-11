import { AppError } from '../lib/errors.js';

/**
 * Per-socket token bucket.
 *
 * HTTP rate limiting does not cover WebSocket frames, and a socket that has
 * already authenticated is exactly where abuse is cheapest: one connection can
 * emit thousands of `message:send` frames a second. Each socket gets its own
 * buckets, discarded with the socket.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    /** Tokens restored per second. */
    private readonly refillRate: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Returns false instead of throwing, for callers that prefer to drop. */
  tryTake(cost = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  take(cost = 1): void {
    if (!this.tryTake(cost)) {
      throw new AppError(429, 'RATE_LIMITED', 'You are doing that too quickly.');
    }
  }
}

export interface SocketBuckets {
  /** Chat messages: bursty typing then send, so allow a small burst. */
  messages: TokenBucket;
  /** Typing indicators are chatty but harmless; drop rather than error. */
  typing: TokenBucket;
  /** Call setup is rare; a tight budget stops call-spam of a single user. */
  calls: TokenBucket;
  /** ICE candidates arrive in bursts during negotiation. */
  signalling: TokenBucket;
}

export function createBuckets(): SocketBuckets {
  return {
    messages: new TokenBucket(20, 5),
    typing: new TokenBucket(10, 4),
    calls: new TokenBucket(5, 0.2),
    signalling: new TokenBucket(120, 40),
  };
}
