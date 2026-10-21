import { useEffect, useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';

type Blocked = { phone: string; reason: string | null; createdAt: string };

/**
 * Administración → Números: bloquear y desbloquear. El bloqueo lo aplica el backend a citas,
 * cuentas, OTP y avisos de WhatsApp. El motivo es interno: el cliente nunca lo ve.
 */
export function AdminBlockedPhones() {
  const [items, setItems] = useState<Blocked[] | null>(null);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () =>
    api<Blocked[]>('admin/blocked-phones')
      .then(setItems)
      .catch((e) => setMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function block(event: FormEvent) {
    event.preventDefault();
    setBusy('block');
    setMessage('');
    try {
      const saved = await api<Blocked>('admin/blocked-phones', {
        method: 'POST',
        body: JSON.stringify({ phone, reason: reason.trim() || undefined }),
      });
      setPhone('');
      setReason('');
      setMessage(`${saved.phone} bloqueado.`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo bloquear.');
    } finally {
      setBusy(null);
    }
  }
  async function unblock(value: string) {
    setBusy(value);
    setMessage('');
    try {
      await api(`admin/blocked-phones/${encodeURIComponent(value)}`, { method: 'DELETE' });
      setConfirm(null);
      setMessage(`${value} desbloqueado.`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo desbloquear.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="team-admin">
      <h2>Números</h2>
      <p className="small">
        Un número bloqueado no puede agendar, crear cuenta ni recibir códigos o avisos por WhatsApp.
        El motivo es solo para el equipo.
      </p>
      <form className="editor" onSubmit={block}>
        <div className="form-row">
          <label>
            Número de WhatsApp
            <input
              required
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={30}
              placeholder="0991234567 o +593991234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <label>
            Motivo interno (opcional)
            <input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <BusyButton
          type="submit"
          className="button"
          disabled={busy !== null}
          busy={busy === 'block'}
          busyLabel="Bloqueando…"
        >
          Bloquear número
        </BusyButton>
      </form>
      {message && (
        <p role="status" className="admin-message">
          {message}
        </p>
      )}
      {items === null && !message && <ListSkeleton label="Cargando números…" count={2} />}
      {items?.length === 0 && <p className="tech-empty">No hay números bloqueados.</p>}
      <div className="team-list">
        {items?.map((b) => (
          <article key={b.phone} className="team-member is-inactive">
            <div>
              <strong>{b.phone}</strong>
              <p>
                Bloqueado el{' '}
                {new Intl.DateTimeFormat('es-EC', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'America/Guayaquil',
                }).format(new Date(b.createdAt))}
                {b.reason ? ` · ${b.reason}` : ''}
              </p>
            </div>
            <div className="tech-actions-row">
              {confirm === b.phone ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={busy !== null}
                    onClick={() => setConfirm(null)}
                  >
                    Mantener
                  </button>
                  <BusyButton
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={busy !== null}
                    busy={busy === b.phone}
                    busyLabel="Desbloqueando…"
                    onClick={() => void unblock(b.phone)}
                  >
                    Sí, desbloquear
                  </BusyButton>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busy !== null}
                  onClick={() => setConfirm(b.phone)}
                >
                  Desbloquear
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
