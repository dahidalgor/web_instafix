import type { Offering } from '@instafix/contracts';
import { useState } from 'react';
import { uploadMedia } from './upload-media';
type Media = Offering['media'];
export function MediaEditor({
  value,
  onChange,
  onBusy,
}: {
  value: Media;
  onChange: (media: Media) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    if (value.length + files.length > 12) {
      setStatus('Puedes añadir hasta 12 archivos por servicio.');
      return;
    }
    setBusy(true);
    onBusy(true);
    let next = [...value];
    try {
      for (const file of Array.from(files)) {
        const type = file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : null;
        if (!type || file.size > (type === 'image' ? 20 : 100) * 1024 * 1024)
          throw new Error(
            `${file.name}: selecciona una foto de hasta 20 MB o un video de hasta 100 MB.`,
          );
        setStatus(`Subiendo ${file.name}…`);
        setProgress(0);
        const media = await uploadMedia(file, type, {
          onProgress: setProgress,
          onProcessing: () => setStatus(`Optimizando ${file.name}…`),
        });
        next = [...next, media];
        onChange(next);
      }
      setStatus('Archivos preparados. Guarda el servicio para publicarlos.');
    } catch (error: any) {
      setStatus(error.message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function move(index: number, offset: number) {
    const copy = [...value];
    [copy[index], copy[index + offset]] = [copy[index + offset], copy[index]];
    onChange(copy);
  }
  return (
    <section className="media-editor">
      <h3>Fotos y videos del trabajo</h3>
      <p className="small">
        Hasta 12 archivos. Fotos: 20 MB. Videos: 100 MB y 60 segundos; se publican sin sonido. El
        primer archivo encabeza la galería.
      </p>
      <label className="media-upload">
        Subir desde mi dispositivo
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          disabled={busy || value.length >= 12}
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {busy && <progress value={progress} max={100} aria-label="Progreso de subida" />}
      {status && <p role="status">{status}</p>}
      <div className="media-editor-grid">
        {value.map((media, i) => (
          <fieldset key={`${media.url}-${i}`}>
            <legend>Contenido {i + 1}</legend>
            {media.type === 'image' ? (
              <img src={media.thumbnail || media.url} alt={media.alt} loading="lazy" />
            ) : (
              <video src={media.url} poster={media.poster} controls preload="none" />
            )}
            <label>
              Descripción de la imagen o video
              <input
                maxLength={200}
                disabled={busy}
                value={media.alt}
                onChange={(e) =>
                  onChange(
                    value.map((item, j) => (j === i ? { ...item, alt: e.target.value } : item)),
                  )
                }
              />
            </label>
            <div className="media-editor-actions">
              <button
                type="button"
                disabled={busy || i === 0}
                onClick={() => move(i, -1)}
                aria-label={`Mover contenido ${i + 1} antes`}
              >
                ←
              </button>
              <button
                type="button"
                disabled={busy || i === value.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Mover contenido ${i + 1} después`}
              >
                →
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Quitar del servicio
              </button>
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
