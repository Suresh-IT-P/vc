'use client';

import { useParams } from 'next/navigation';
import { FollowList } from '@/features/users/FollowList';

export default function FollowingPage() {
  const params = useParams<{ username: string }>();
  return <FollowList username={params?.username ?? ''} kind="following" />;
}
