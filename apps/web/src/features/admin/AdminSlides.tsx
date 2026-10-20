import { useEffect, useState, type FormEvent } from 'react';
import type { SiteSlide } from '@instafix/contracts/src/site';
import { BusyButton } from '../../components/ui/BusyButton';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import { MediaEditor } from '../media/MediaEditor';

const empty: Omit<SiteSlide, 'id'> = {
  label: '',
  title: '',
  description: '',
  detail: '',
  symbol: '✦',
  media: [],
  position: 0,
  published: false,
};
export function AdminSlides({ onUploading }: { onUploading: (busy: boolean) => void }) {
  const [slides, setSlides] = useState<SiteSlide[] | null>(null);
  const [draft, setDraft] = useState({ ...empty, id: '' });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const load = () => api<SiteSlide[]>('admin/slides').then(setSlides);
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (uploading || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const { id, ...data } = draft;
      await api(id ? `admin/slides/${id}` : 'admin/slides', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      await load();
      setDraft({ ...empty, id: '' });
      setMessage('Presentación guardada.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>Presentación de nuestro trabajo</h2>
      <p>
        Administra las diapositivas de «Nuestro trabajo», en Inicio. Menor posición aparece primero.
        Desmarca «Publicada» para retirar una diapositiva sin perderla.
      </p>
      {slides === null && !message && (
        <div className="filters">
          <SkeletonGroup label="Cargando diapositivas…">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width={120} height={38} radius={999} />
            ))}
          </SkeletonGroup>
        </div>
      )}
      <div className="filters">
        {slides?.map((s) => (
          <button
            key={s.id}
            disabled={busy || uploading}
            onClick={() => {
              const { id, label, title, description, detail, symbol, media, position, published } =
                s;
              setDraft({
                id,
                label,
                title,
                description,
                detail,
                symbol,
                media,
                position,
                published,
              });
            }}
          >
            {s.title} {s.published ? '· Publicada' : '· Borrador'}
          </button>
        ))}
      </div>
      <form className="editor" onSubmit={save}>
        <h3>{draft.id ? 'Editar diapositiva' : 'Nueva diapositiva'}</h3>
        {(['label', 'title', 'detail'] as const).map((key) => (
          <label key={key}>
            {{ label: 'Categoría', title: 'Título', detail: 'Pie de imagen' }[key]}
            <input
              required={key !== 'detail'}
              maxLength={key === 'title' ? 150 : key === 'label' ? 60 : 100}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <label>
          Descripción
          <textarea
            required
            minLength={10}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <label>
          Posición
          <input
            type="number"
            min={0}
            max={1000}
            value={draft.position}
            onChange={(e) => setDraft({ ...draft, position: Number(e.target.value) })}
            required
          />
        </label>
        <MediaEditor
          maxFiles={1}
          value={draft.media}
          onChange={(media) => setDraft((previous) => ({ ...previous, media }))}
          onBusy={(value) => {
            setUploading(value);
            onUploading(value);
          }}
        />
        <label className="consent">
          <input
            type="checkbox"
            checked={draft.published}
            onChange={(e) => setDraft({ ...draft, published: e.target.checked })}
          />
          Publicada
        </label>
        <div className="admin-form-actions">
          <BusyButton
            type="submit"
            className="button"
            disabled={uploading}
            busy={busy}
            busyLabel="Guardando…"
          >
            Guardar diapositiva
          </BusyButton>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || uploading}
            onClick={() => setDraft({ ...empty, id: '' })}
          >
            Nueva diapositiva
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
