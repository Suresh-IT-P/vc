'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/controls';
import { useAuthStore } from '@/store/auth';
import { RealtimeBridge } from '@/features/realtime/RealtimeBridge';
import { CallLayer } from '@/features/calling/CallLayer';
import { useViewportHeight } from '@/hooks/useViewportHeight';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Socket events push the fast-moving data (messages, presence, calls),
        // so polling would be redundant; these settings just avoid refetch churn.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          // Never retry an auth or validation failure — it will fail identically.
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);
  const bootstrap = useAuthStore((state) => state.bootstrap);

  useViewportHeight();

  React.useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider delayDuration={300}>
          {/* Keeps sockets, presence and inbound calls alive across navigation. */}
          <RealtimeBridge />
          {children}
          {/* Rendered above everything so an incoming call is never hidden. */}
          <CallLayer />
          <Toaster
            position="top-center"
            richColors
            closeButton
            toastOptions={{ className: 'font-sans' }}
          />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
