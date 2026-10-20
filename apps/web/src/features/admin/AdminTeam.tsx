import type { StaffMember } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { BusyLabel } from '../../components/ui/BusyLabel';
import { Disclosure } from '../../components/ui/Disclosure';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api, ApiError } from '../../lib/api';

const empty = { firstName: '', lastName: '', phone: '', email: '', password: '' };
type Profile = { firstName: string; lastName: string; phone: string; email: string };

/** Administración → Equipo: alta y gestión de técnicos. Los permisos se aplican en la API. */
export function AdminTeam() {
  // null mientras carga: distingue la carga de un equipo vacío.
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState({ ...empty });
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile>({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
  });
  // Aviso de citas futuras antes de desactivar a un técnico.
  const [confirmDeactivate, setConfirmDeactivate] = useState<{ id: string; text: string } | null>(
    null,
  );
  const load = () =>
    api<StaffMember[]>('admin/staff')
      .then((next) => {
        setMembers(next);
        setLoadError('');
      })
      .catch((e) => setLoadError(e.message));
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
    if (ok) {
      setDraft({ ...empty });
      setCreateOpen(false);
    }
  }
  function startEdit(m: StaffMember) {
    setResetFor(null);
    setConfirmDeactivate(null);
    if (editing === m.id) {
      setEditing(null);
      return;
    }
    setEditing(m.id);
    // Cuentas antiguas sin nombre separado: se parte el nombre visible como valor inicial.
    const [first, ...rest] = m.name.split(' ');
    setProfile({
      firstName: m.firstName || first || '',
      lastName: m.lastName || rest.join(' '),
      phone: m.phone,
      email: m.email || '',
    });
  }
  async function saveProfile(event: FormEvent, id: string) {
    event.preventDefault();
    const ok = await run(
      () => api(`admin/staff/${id}`, { method: 'PATCH', body: JSON.stringify(profile) }),
      'Datos del técnico actualizados.',
    );
    if (ok) setEditing(null);
  }
  async function setActive(m: StaffMember, active: boolean, confirmed = false) {
    setBusy(true);
    setMessage('');
    try {
      await api(`admin/staff/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active, ...(confirmed ? { confirmFutureAppointments: true } : {}) }),
      });
      setConfirmDeactivate(null);
      setMessage(active ? 'Técnico activado.' : 'Técnico desactivado; sus sesiones se cerraron.');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TECHNICIAN_HAS_UPCOMING')
        setConfirmDeactivate({ id: m.id, text: e.message });
      else setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: e.target.value });
  const setField = (key: keyof Profile) => (e: { target: { value: string } }) =>
    setProfile({ ...profile, [key]: e.target.value });
  return (
    <section className="team-admin">
      <h2>Equipo</h2>
      <p className="small">
        Los técnicos solo ven su panel: citas pendientes, sus visitas e historial. No acceden a la
        configuración ni a la administración.
      </p>
      {message && (
        <p role="status" className="admin-message">
          {message}
        </p>
      )}
      <Disclosure
        open={createOpen}
        onToggle={setCreateOpen}
        title="Nuevo técnico"
        className="appt-editor"
      >
        <form className="editor" onSubmit={create}>
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
            <input
              required
              type="tel"
              inputMode="tel"
              value={draft.phone}
              onChange={set('phone')}
            />
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
            <BusyLabel busy={busy} label="Crear técnico" busyLabel="Guardando…" />
          </button>
        </form>
      </Disclosure>
      {members === null && loadError && (
        <div className="admin-message" role="alert">
          {loadError}{' '}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>
            Reintentar
          </button>
        </div>
      )}
      {members === null && !loadError && <ListSkeleton label="Cargando equipo…" count={3} />}
      {members?.length === 0 && <p className="tech-empty">Todavía no hay técnicos.</p>}
      <div className="team-list">
        {members?.map((m) => (
          <article key={m.id} className={`team-member ${m.active ? '' : 'is-inactive'}`}>
            <div>
              <strong>{m.name}</strong>
              <p>
                {m.role === 'ADMIN' ? 'Administrador' : 'Técnico'} · {m.phone}
                {m.email ? ` · ${m.email}` : ''}
                {m.active ? '' : ' · Desactivado'}
                {m.role === 'TECHNICIAN' &&
                  !!m.upcomingAppointments &&
                  ` · ${m.upcomingAppointments === 1 ? '1 cita futura' : `${m.upcomingAppointments} citas futuras`}`}
              </p>
            </div>
            {m.role === 'TECHNICIAN' && (
              <div className="tech-actions-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-expanded={editing === m.id}
                  disabled={busy}
                  onClick={() => startEdit(m)}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  aria-expanded={resetFor === m.id}
                  disabled={busy}
                  onClick={() => {
                    setEditing(null);
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
                  onClick={() => void setActive(m, !m.active)}
                >
                  {m.active ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            )}
            {confirmDeactivate?.id === m.id && (
              <div className="team-confirm" role="alertdialog" aria-label="Confirmar desactivación">
                <p>{confirmDeactivate.text} Su historial no se modifica.</p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmDeactivate(null)}
                  >
                    Mantener activo
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void setActive(m, false, true)}
                  >
                    <BusyLabel
                      busy={busy}
                      label="Desactivar igualmente"
                      busyLabel="Desactivando…"
                    />
                  </button>
                </div>
              </div>
            )}
            {editing === m.id && (
              <form className="team-edit" onSubmit={(e) => void saveProfile(e, m.id)}>
                <div className="form-row">
                  <label>
                    Nombre
                    <input
                      required
                      minLength={2}
                      maxLength={50}
                      value={profile.firstName}
                      onChange={setField('firstName')}
                    />
                  </label>
                  <label>
                    Apellido
                    <input
                      required
                      minLength={2}
                      maxLength={50}
                      value={profile.lastName}
                      onChange={setField('lastName')}
                    />
                  </label>
                </div>
                <label>
                  WhatsApp / teléfono de acceso
                  <input
                    required
                    type="tel"
                    inputMode="tel"
                    maxLength={30}
                    value={profile.phone}
                    onChange={setField('phone')}
                  />
                </label>
                <label>
                  Correo (opcional)
                  <input
                    type="email"
                    maxLength={254}
                    value={profile.email}
                    onChange={setField('email')}
                  />
                </label>
                <p className="small">
                  Cambiar el teléfono cierra sus sesiones: deberá entrar con el número nuevo. Sus
                  visitas futuras mostrarán el nombre actualizado; el historial se conserva.
                </p>
                <div className="confirm-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                    Cancelar
                  </button>
                  <button className="btn btn-primary" disabled={busy}>
                    <BusyLabel busy={busy} label="Guardar cambios" busyLabel="Guardando…" />
                  </button>
                </div>
              </form>
            )}
            {resetFor === m.id && (
              <form
                className="tech-actions-row team-password"
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
                <label>
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
  );
}
