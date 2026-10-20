import type { FormEvent } from 'react';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import { type Equipment, type RunAction } from './admin.types';
type Props = {
  equipment: Equipment[];
  run: RunAction;
  load: () => Promise<void>;
  busy: boolean;
  loading?: boolean;
};
export function AdminEquipment({ equipment, run, load, busy, loading }: Props) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    run(async () => {
      await api('admin/equipment', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(data)),
      });
      await load();
      form.reset();
    });
  }

  return (
    <form className="editor" onSubmit={handleSubmit}>
      <h2>Equipos</h2>
      {loading && <ListSkeleton label="Cargando equipos…" count={3} />}
      {equipment.map((item) => (
        <p key={item.id}>
          {item.category} / {item.name}
        </p>
      ))}
      <label>
        Categoría
        <input name="category" required minLength={2} maxLength={100} placeholder="Consolas" />
      </label>
      <label>
        Equipo
        <input name="name" required minLength={2} maxLength={100} placeholder="PS5" />
      </label>
      <button className="button" disabled={busy}>
        Añadir equipo
      </button>
    </form>
  );
}
