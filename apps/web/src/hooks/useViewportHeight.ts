'use client';

import { useEffect } from 'react';

/**
 * Keeps `--app-height` equal to the *visible* viewport height.
 *
 * On mobile browsers `100vh` includes the area behind the collapsing URL bar,
 * so a full-height chat screen ends up with its composer pushed off-screen.
 * `visualViewport` reports what the user can actually see, including when the
 * on-screen keyboard is open — which is exactly when the chat composer needs to
 * stay put.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    };

    update();

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
}
