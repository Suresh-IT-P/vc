import bcrypt from 'bcryptjs';
import { isTest } from '../env.js';

/**
 * bcrypt cost. 12 is the current sensible default for interactive logins
 * (~250 ms on commodity hardware). Tests drop to the minimum because they
 * create dozens of accounts and we are not measuring bcrypt.
 */
const COST = isTest ? 4 : 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash must read as "wrong password", never as a 500.
    return false;
  }
}

/**
 * Constant-ish-time dummy comparison. Called on the "user not found" branch of
 * login so that a missing account and a wrong password take a similar amount of
 * time, which stops the endpoint from being a username oracle.
 */
const DUMMY_HASH = bcrypt.hashSync('sonder-timing-equaliser', COST);

export async function burnPasswordTime(): Promise<void> {
  await bcrypt.compare('sonder-timing-equaliser', DUMMY_HASH);
}
