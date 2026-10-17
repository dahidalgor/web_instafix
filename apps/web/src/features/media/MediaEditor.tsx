import { MAX_VIDEOS, mediaProblem, type Offering } from '@instafix/contracts';
import { useState } from 'react';
import { uploadMedia } from './upload-media';
type Media = Offering['media'];
export function MediaEditor({
  value,
  maxFiles = 12,
  onChange,
  onBusy,
}: {
  value: Media;
  maxFiles?: number;
  onChange: (media: Media) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    if (value.length + files.length > maxFiles) {
      setStatus(`Puedes añadir hasta ${maxFiles} archivos.`);
      return;
    }
    const videos = value.filter((item) => item.type === 'video').length;
    const incoming = Array.from(files).filter((file) => file.type.startsWith('video/')).length;
    if (videos + incoming > MAX_VIDEOS) {
      setStatus(`Cada servicio admite como máximo ${MAX_VIDEOS} videos.`);
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
      // Un video nuevo justo después de otro se avisa: hay que intercalar una imagen.
      setStatus(mediaProblem(next) || 'Archivos preparados. Guarda los cambios para publicarlos.');
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
    // Reordenar no puede dejar dos videos seguidos.
    const problem = mediaProblem(copy);
    if (problem && !mediaProblem(value)) {
      setStatus(problem);
      return;
    }
    setStatus(problem || '');
    onChange(copy);
  }
  const problem = maxFiles > 1 ? mediaProblem(value) : null;
  return (
    <section className="media-editor">
      <h3>Fotos y videos del trabajo</h3>
      <p className="small">
        Hasta {maxFiles} archivos. Fotos: 20 MB. Videos: 100 MB y 60 segundos; se publican sin
        sonido.{maxFiles > 1 && ` Máximo ${MAX_VIDEOS} videos, separados por al menos una imagen.`}
      </p>
      <label className="media-upload">
        Subir desde mi dispositivo
        <input
          type="file"
          multiple={maxFiles > 1}
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          disabled={busy || value.length >= maxFiles}
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {busy && <progress value={progress} max={100} aria-label="Progreso de subida" />}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
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
                Quitar archivo
              </button>
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
