'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SonderWordmark } from '@/components/brand';
import { FullPageSpinner } from '@/components/ui/feedback';
import { useAuthStore } from '@/store/auth';
import { APP_TAGLINE } from '@sonder/shared';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  if (status === 'loading') {
    return (
      <div className="app-shell flex items-center justify-center">
        <FullPageSpinner label="Checking your session" />
      </div>
    );
  }

  return (
    <div className="app-shell grid lg:grid-cols-2">
      {/* Marketing panel — desktop only, so mobile gets straight to the form. */}
      <aside className="relative hidden overflow-hidden bg-brand-gradient p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-[28rem] rounded-full bg-white/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-20 size-[24rem] rounded-full bg-black/15 blur-3xl"
        />

        <SonderWordmark className="relative [&_span]:!text-white [&_span]:!bg-none" />

        <div className="relative max-w-md space-y-6">
          <h1 className="font-display text-4xl font-extrabold leading-tight">
            {APP_TAGLINE}
          </h1>
          <p className="text-lg text-white/85">
            Message and call the people you know — with real-time voice conversion
            that runs entirely on your device.
          </p>
          <ul className="space-y-3 text-sm text-white/85">
            {[
              'Instant one-to-one messaging with delivery and read receipts',
              'Peer-to-peer audio calls over WebRTC',
              'Live male-to-female voice conversion, processed locally',
            ].map((line) => (
              <li key={line} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-white/80"
                />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/60">
          Your microphone is only used during calls you start, and audio is never
          uploaded for processing.
        </p>
      </aside>

      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center lg:hidden">
            <SonderWordmark />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
