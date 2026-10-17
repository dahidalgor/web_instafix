import type { StaffMember } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';

const empty = { firstName: '', lastName: '', phone: '', email: '', password: '' };

/** Administración → Equipo: alta y gestión de técnicos. Los permisos se aplican en la API. */
export function AdminTeam() {
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [draft, setDraft] = useState({ ...empty });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const load = () =>
    api<StaffMember[]>('admin/staff')
      .then(setMembers)
      .catch((e) => setMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(done);
      await load();
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      () => api('admin/staff', { method: 'POST', body: JSON.stringify(draft) }),
      'Técnico creado. Ya puede iniciar sesión en el panel con su teléfono y contraseña.',
    );
    if (ok) setDraft({ ...empty });
  }
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: e.target.value });
  return (
    <div className="admin-layout">
      <section>
        <h2>Equipo</h2>
        <p className="small">
          Los técnicos solo ven su panel: citas pendientes, sus visitas e historial. No acceden a la
          configuración ni a la administración.
        </p>
        {message && <p role="status">{message}</p>}
        <div className="team-list">
          {members.map((m) => (
            <article key={m.id} className={`team-member ${m.active ? '' : 'is-inactive'}`}>
              <div>
                <strong>{m.name}</strong>
                <p>
                  {m.role === 'ADMIN' ? 'Administrador' : 'Técnico'} · {m.phone}
                  {m.email ? ` · ${m.email}` : ''}
                  {m.active ? '' : ' · Desactivado'}
                </p>
              </div>
              {m.role === 'TECHNICIAN' && (
                <div className="tech-actions-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={busy}
                    onClick={() => {
                      setResetFor(resetFor === m.id ? null : m.id);
                      setNewPassword('');
                    }}
                  >
                    Cambiar contraseña
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small ${m.active ? 'btn-danger' : 'btn-secondary'}`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          api(`admin/staff/${m.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ active: !m.active }),
                          }),
                        m.active
                          ? 'Técnico desactivado; sus sesiones se cerraron.'
                          : 'Técnico activado.',
                      )
                    }
                  >
                    {m.active ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              )}
              {resetFor === m.id && (
                <form
                  className="tech-actions-row"
                  style={{ width: '100%' }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const ok = await run(
                      () =>
                        api(`admin/staff/${m.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ password: newPassword }),
                        }),
                      'Contraseña actualizada; las sesiones abiertas se cerraron.',
                    );
                    if (ok) setResetFor(null);
                  }}
                >
                  <label style={{ flex: '2 1 220px', margin: 0 }}>
                    Nueva contraseña (mínimo 12 caracteres)
                    <input
                      type="password"
                      minLength={12}
                      maxLength={128}
                      required
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </label>
                  <button className="btn btn-primary" disabled={busy}>
                    Guardar
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      </section>
      <form className="editor" onSubmit={create}>
        <h3>Nuevo técnico</h3>
        <div className="form-row">
          <label>
            Nombre
            <input
              required
              minLength={2}
              maxLength={50}
              value={draft.firstName}
              onChange={set('firstName')}
            />
          </label>
          <label>
            Apellido
            <input
              required
              minLength={2}
              maxLength={50}
              value={draft.lastName}
              onChange={set('lastName')}
            />
          </label>
        </div>
        <label>
          WhatsApp / teléfono (inicia sesión con este número)
          <input required type="tel" inputMode="tel" value={draft.phone} onChange={set('phone')} />
        </label>
        <label>
          Correo (opcional)
          <input type="email" maxLength={254} value={draft.email} onChange={set('email')} />
        </label>
        <label>
          Contraseña inicial (mínimo 12 caracteres)
          <input
            required
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            value={draft.password}
            onChange={set('password')}
          />
        </label>
        <p className="small">
          Compártela con el técnico por un canal privado; puede cambiarla después.
        </p>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Guardando…' : 'Crear técnico'}
        </button>
      </form>
    </div>
  );
}
