import type { AccountUser } from '@instafix/contracts';
import type { FormEvent } from 'react';
import { api } from '../../lib/api';
import { type RunAction } from './admin.types';
type Props = { users: AccountUser[]; run: RunAction; busy: boolean };
export function AdminJobs({ users, run, busy }: Props) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    run(async () => {
      await api('admin/jobs', {
        method: 'POST',
        body: JSON.stringify({ ...data, priceMinor: Math.round(Number(data.price) * 100) }),
      });
      form.reset();
    });
  }

  return (
    <form className="editor" onSubmit={handleSubmit}>
      <h2>Registrar trabajo completado</h2>
      <p>
        Comprueba la identidad del cliente antes de vincular un trabajo a su cuenta. El teléfono
        registrado aún no acredita su propiedad.
      </p>
      <label>
        Cliente
        <select required name="userId">
          <option value="">Seleccionar cuenta</option>
          {users
            .filter((u) => u.role === 'CUSTOMER')
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.phone} · {u.id.slice(0, 8)}
              </option>
            ))}
        </select>
      </label>
      <label>
        Servicio realizado
        <input name="title" required minLength={3} maxLength={150} />
      </label>
      <label>
        Equipo
        <input name="device" required maxLength={100} />
      </label>
      <label>
        Precio USD
        <input name="price" type="number" required min="0" max="100000" step="0.01" />
      </label>
      <label>
        Fecha de finalización
        <input name="completedAt" type="datetime-local" required />
      </label>
      <label>
        Vencimiento de garantía (opcional)
        <input name="warrantyEndsAt" type="datetime-local" />
      </label>
      <label>
        Condiciones de garantía de este trabajo
        <textarea name="warrantyTerms" required maxLength={5000} />
      </label>
      <button className="button" disabled={busy}>
        Registrar trabajo
      </button>
    </form>
  );
}
