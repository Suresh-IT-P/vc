import { createHmac } from 'node:crypto';
import type { IceConfigResponse, IceServerConfig } from '@sonder/shared';
import { env, hasTurn } from '../../env.js';

/**
 * coturn "REST API" ephemeral credentials, as implemented by coturn's
 * `--use-auth-secret` / `--static-auth-secret`:
 *
 *   username   = <unix-expiry>:<userId>
 *   credential = base64( HMAC-SHA1( secret, username ) )
 *
 * The shared secret never leaves the server, and a leaked credential stops
 * working when it expires. Handing out a long-lived static TURN password is the
 * usual way people end up paying for someone else's relayed traffic.
 *
 * Pure and exported so it can be tested without touching process.env.
 */
export function mintTurnCredentials(
  secret: string,
  userId: string,
  ttlSeconds: number,
  now: number = Date.now(),
): { username: string; credential: string; expiresAt: number } {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry };
}

/** Builds the ICE server list handed to the browser. */
export function buildIceConfig(userId: string): IceConfigResponse {
  const iceServers: IceServerConfig[] = [];

  if (env.STUN_SERVERS.length > 0) {
    iceServers.push({ urls: env.STUN_SERVERS });
  }

  if (env.TURN_SERVER) {
    const urls = env.TURN_SERVER.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (env.TURN_SECRET) {
      const { username, credential } = mintTurnCredentials(
        env.TURN_SECRET,
        userId,
        env.TURN_CREDENTIAL_TTL,
      );
      iceServers.push({ urls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_PASSWORD) {
      iceServers.push({
        urls,
        username: env.TURN_USERNAME,
        credential: env.TURN_PASSWORD,
      });
    }
  }

  return {
    iceServers,
    ttl: env.TURN_CREDENTIAL_TTL,
    hasTurn,
  };
}
