import type { ServiceCover } from '@instafix/contracts';
import { useState } from 'react';
import { BusyLabel } from '../../components/ui/BusyLabel';
import { uploadMedia } from './upload-media';

/** Portada del servicio: una imagen propia, independiente de la galería. Usa la subida actual (R2). */
export function CoverEditor({
  value,
  fallback,
  onChange,
  onBusy,
}: {
  value: ServiceCover | null | undefined;
  fallback: string | null;
  onChange: (cover: ServiceCover | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  async function upload(file: File | undefined) {
    if (!file || busy) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) {
      setStatus('La portada debe ser una foto JPG, PNG o WebP de hasta 20 MB.');
      return;
    }
    setBusy(true);
    onBusy(true);
    setProgress(0);
    setStatus(`Subiendo ${file.name}…`);
    try {
      const media = await uploadMedia(file, 'image', {
        onProgress: setProgress,
        onProcessing: () => setStatus('Optimizando la portada…'),
      });
      onChange({ url: media.url, thumbnail: media.thumbnail, alt: value?.alt || '' });
      setStatus('Portada lista. Guarda el servicio para publicarla.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No pudimos subir la portada.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  const preview = value?.thumbnail || value?.url;
  return (
    <section className="media-editor cover-editor">
      <h3>Imagen de portada</h3>
      <p className="small">
        Se muestra en las tarjetas y en el detalle del servicio. Es independiente de la galería.
      </p>
      <div className="cover-preview">
        {preview ? (
          <img src={preview} alt={value?.alt || 'Portada del servicio'} />
        ) : (
          <div className="cover-empty">
            {fallback ? (
              <>
                <img src={fallback} alt="" />
                <span>Sin portada: se usa la primera foto de la galería</span>
              </>
            ) : (
              <span>Sin portada</span>
            )}
          </div>
        )}
      </div>
      {busy && (
        <progress value={progress} max={100} aria-label="Progreso de subida de la portada" />
      )}
      {status && <p role="status">{status}</p>}
      <div className="tech-actions-row">
        <label className="btn btn-secondary" aria-busy={busy || undefined}>
          <BusyLabel
            busy={busy}
            label={value ? 'Reemplazar portada' : 'Subir portada'}
            busyLabel="Subiendo portada…"
          />
          <input
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        {value && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => onChange(null)}
          >
            Quitar portada
          </button>
        )}
      </div>
      {value && (
        <label>
          Descripción de la portada
          <input
            maxLength={200}
            value={value.alt}
            onChange={(e) => onChange({ ...value, alt: e.target.value })}
          />
        </label>
      )}
    </section>
  );
}
