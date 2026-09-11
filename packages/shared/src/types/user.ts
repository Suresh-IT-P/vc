/** A user as exposed to other users (never contains passwordHash / email). */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  /** Present only on profile endpoints. */
  counts?: {
    posts: number;
    followers: number;
    following: number;
  };
  /** Relationship of the *requesting* user to this user. */
  viewer?: {
    isSelf: boolean;
    isFollowing: boolean;
    isFollowedBy: boolean;
    isBlocked: boolean;
    hasBlockedMe: boolean;
  };
}

/** The authenticated user's own record. */
export interface SelfUser extends PublicUser {
  email: string;
  createdAt: string;
}

export interface AuthResult {
  user: SelfUser;
  accessToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

export type PresenceState = 'online' | 'offline';

export interface PresenceUpdate {
  userId: string;
  state: PresenceState;
  lastSeenAt: string | null;
}
