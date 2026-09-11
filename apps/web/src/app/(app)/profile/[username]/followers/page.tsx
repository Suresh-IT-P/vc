'use client';

import { useParams } from 'next/navigation';
import { FollowList } from '@/features/users/FollowList';

export default function FollowersPage() {
  const params = useParams<{ username: string }>();
  return <FollowList username={params?.username ?? ''} kind="followers" />;
}
