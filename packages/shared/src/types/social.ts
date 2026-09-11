/**
 * DEMO-tier social content. These are served from seeded rows so the shell
 * feels alive; they are deliberately *not* a full social backend. See
 * docs/architecture.md "Real vs Demo" for the boundary.
 */
export interface DemoAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isRealUser: boolean;
}

export interface Post {
  id: string;
  author: DemoAuthor;
  mediaUrl: string;
  mediaKind: 'image' | 'video';
  caption: string;
  location: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  likedByMe: boolean;
  savedByMe: boolean;
  comments: Comment[];
}

export interface Comment {
  id: string;
  author: DemoAuthor;
  body: string;
  createdAt: string;
  likeCount: number;
}

export interface Story {
  id: string;
  author: DemoAuthor;
  mediaUrl: string;
  seen: boolean;
  createdAt: string;
}

export interface Reel {
  id: string;
  author: DemoAuthor;
  videoUrl: string;
  posterUrl: string;
  caption: string;
  audioLabel: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByMe: boolean;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: 'like' | 'comment' | 'follow' | 'mention' | 'call' | 'message';
  actor: DemoAuthor;
  text: string;
  createdAt: string;
  read: boolean;
  /** Real notifications (call/message) deep-link into the real features. */
  href: string | null;
  isReal: boolean;
}
