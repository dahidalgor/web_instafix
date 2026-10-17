import type { Offering } from '@instafix/contracts';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { money } from '../../lib/format';
import { availabilityLabels } from '../catalog/catalog.constants';
import { MediaEditor } from '../media/MediaEditor';
import { CoverEditor } from '../media/CoverEditor';
import { mediaProblem, serviceCover } from '@instafix/contracts';
import { emptyService, type Equipment, type ServiceDraft } from './admin.types';
type Props = {
  items: Offering[];
  equipment: Equipment[];
  draft: ServiceDraft;
  setDraft: Dispatch<SetStateAction<ServiceDraft>>;
  update: <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => void;
  uploading: boolean;
  setUploading: (value: boolean) => void;
  save: (event: FormEvent) => Promise<void>;
  busy: boolean;
};
export function AdminServices({
  items,
  equipment,
  draft,
  setDraft,
  update,
  uploading,
  setUploading,
  save,
  busy,
}: Props) {
  return (
    <div className="admin-layout">
      <section>
        <h2>Catálogo</h2>
        <button disabled={uploading} onClick={() => setDraft({ ...emptyService })}>
          + Nuevo servicio
        </button>
        {items.map((item) => (
          <button
            className="admin-item admin-service-item"
            disabled={uploading}
            key={item.id}
            onClick={() =>
              setDraft({
                id: item.id,
                title: item.title,
                equipmentId: item.equipmentId ?? '',
                description: item.description,
                priceMinor: item.priceMinor,
                durationMinutes: item.durationMinutes,
                warrantyDays: item.warrantyDays,
                availability: item.availability,
                media: item.media,
                cover: item.cover ?? null,
              })
            }
          >
            {serviceCover(item) && (
              <img
                src={serviceCover(item)!.thumbnail || serviceCover(item)!.url}
                alt=""
                loading="lazy"
              />
            )}
            <strong>
              {item.device} · {item.title}
            </strong>
            <span>
              {money(item.priceMinor)} · {availabilityLabels[item.availability]}
            </span>
          </button>
        ))}
      </section>
      <form className="editor" onSubmit={save}>
        <h2>{draft.id ? 'Editar servicio' : 'Nuevo servicio'}</h2>
        <label>
          Equipo
          <select
            required
            value={draft.equipmentId}
            onChange={(e) => update('equipmentId', e.target.value)}
          >
            <option value="">Selecciona equipo</option>
            {equipment.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nombre
          <input
            required
            minLength={3}
            maxLength={150}
            value={draft.title}
            onChange={(e) => update('title', e.target.value)}
          />
        </label>
        <label>
          Descripción
          <textarea
            required
            minLength={10}
            maxLength={5000}
            value={draft.description}
            onChange={(e) => update('description', e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Precio USD
            <input
              type="number"
              min="0"
              max="100000"
              step="0.01"
              required
              value={draft.priceMinor / 100}
              onChange={(e) => update('priceMinor', Math.round(Number(e.target.value) * 100))}
            />
          </label>
          <label>
            Disponibilidad
            <select
              value={draft.availability}
              onChange={(e) =>
                update('availability', e.target.value as ServiceDraft['availability'])
              }
            >
              {Object.entries(availabilityLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Duración (minutos)
            <input
              type="number"
              min="1"
              max="1440"
              required
              value={draft.durationMinutes}
              onChange={(e) => update('durationMinutes', Number(e.target.value))}
            />
          </label>
          <label>
            Garantía anunciada (días)
            <input
              type="number"
              min="0"
              max="3650"
              required
              value={draft.warrantyDays}
              onChange={(e) => update('warrantyDays', Number(e.target.value))}
            />
          </label>
        </div>
        <CoverEditor
          key={`cover-${draft.id || 'new'}`}
          value={draft.cover}
          fallback={
            draft.cover ? null : (serviceCover({ cover: null, media: draft.media })?.url ?? null)
          }
          onChange={(cover) => update('cover', cover)}
          onBusy={setUploading}
        />
        <MediaEditor
          key={draft.id || 'new'}
          value={draft.media}
          onChange={(media) => update('media', media)}
          onBusy={setUploading}
        />
        <button className="button" disabled={busy || uploading || !!mediaProblem(draft.media)}>
          Guardar servicio
        </button>
      </form>
    </div>
  );
}
