import type { Offering } from '@instafix/contracts';
import { useEffect, useRef, useState } from 'react';

export function MediaCarousel({ media }: { media: Offering['media'] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const stopped = reduced;
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const videos = Array.from(root.querySelectorAll('video'));
    const visible = new Set<HTMLVideoElement>();
    const update = () =>
      videos.forEach((video) => {
        if (visible.has(video) && !document.hidden && !stopped) void video.play().catch(() => {});
        else video.pause();
      });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting) visible.add(video);
          else visible.delete(video);
        });
        update();
      },
      { threshold: 0.1 },
    );
    videos.forEach((video) => {
      video.muted = true;
      observer.observe(video);
    });
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      videos.forEach((video) => video.pause());
      document.removeEventListener('visibilitychange', update);
    };
  }, [media, stopped]);
  if (!media.length) return null;
  return (
    <section className="media-gallery" aria-label="Fotos y videos del servicio">
      <div className="media-toolbar">
        <span>Nuestro trabajo</span>
      </div>
      <div
        className={`media-viewport ${reduced ? 'is-reduced' : ''}`}
        ref={viewport}
        tabIndex={reduced ? 0 : undefined}
        aria-label="Galería de nuestro trabajo"
      >
        <div className="media-track">
          {[0, 1].map((copy) => (
            <div
              key={copy}
              className={`media-group ${copy ? 'media-copy' : ''}`}
              aria-hidden={copy ? true : undefined}
            >
              {media.map((item, index) => (
                <figure key={index}>
                  {item.type === 'image' ? (
                    <img
                      src={item.url}
                      srcSet={
                        item.thumbnail ? `${item.thumbnail} 640w, ${item.url} 1600w` : undefined
                      }
                      sizes="(max-width: 700px) 90vw, 640px"
                      alt={copy ? '' : item.alt}
                      loading="lazy"
                    />
                  ) : (
                    <video
                      src={item.url}
                      poster={item.poster}
                      muted
                      loop
                      playsInline
                      preload="none"
                      controls={!copy && stopped}
                      tabIndex={copy ? -1 : 0}
                      aria-label={item.alt || 'Video de nuestro trabajo'}
                    />
                  )}
                </figure>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
