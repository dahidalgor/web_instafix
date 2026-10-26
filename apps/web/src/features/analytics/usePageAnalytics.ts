import { useEffect } from 'react';
import type { TrackedPage } from '@instafix/contracts/src/site';

/** Una visita por navegación. Solo suma tiempo visible; no mide personas identificables. */
export function usePageAnalytics(page: TrackedPage) {
  useEffect(() => {
    if (navigator.doNotTrack === '1') return;
    let sessionId: string;
    try {
      sessionId = sessionStorage.getItem('instafix:visit-session') || crypto.randomUUID();
      sessionStorage.setItem('instafix:visit-session', sessionId);
    } catch {
      return;
    }
    const id = crypto.randomUUID();
    let total = 0;
    let since = performance.now();
    let visible = document.visibilityState === 'visible';
    let closed = false;
    const flush = () => {
      if (closed) return;
      const now = performance.now();
      if (visible) total += now - since;
      since = now;
      visible = document.visibilityState === 'visible';
      const body = JSON.stringify({
        id,
        sessionId,
        page,
        activeSeconds: Math.min(14400, Math.floor(total / 1000)),
      });
      void fetch('/api/v1/analytics/visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'omit',
        keepalive: true,
      }).catch(() => {
        /* La medición nunca interrumpe la navegación. */
      });
    };
    // Evita una visita adicional por el montaje de diagnóstico de React StrictMode.
    const start = window.setTimeout(flush, 0);
    const interval = window.setInterval(flush, 15000);
    const hide = () => {
      flush();
      visible = false;
    };
    const show = () => {
      since = performance.now();
      visible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(interval);
      if (performance.now() - since > 50 || total > 0) flush();
      closed = true;
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [page]);
}
