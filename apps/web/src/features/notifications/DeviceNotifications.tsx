import type { StaffPushStatus } from '@instafix/contracts/src/push';
import { useEffect, useState } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { pushApi } from './push-api';
import {
  browserEnv,
  detectSupport,
  disablePush,
  enablePush,
  installationId,
  isIos,
  type Support,
} from './push-client';

type Busy = 'enable' | 'disable' | 'test' | null;
const date = (value: string) =>
  new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Guayaquil',
  }).format(new Date(value));

/**
 * Mi cuenta → Notificaciones: avisos push en ESTE dispositivo (administración y técnicos).
 * El permiso solo se pide al pulsar «Activar notificaciones», nunca al cargar.
 */
export function DeviceNotifications() {
  const [env] = useState(browserEnv);
  const [support] = useState<Support>(() => detectSupport(env));
  const [permission, setPermission] = useState(env.notification?.permission ?? 'default');
  const [status, setStatus] = useState<StaffPushStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<Busy>(null);

  const refresh = () =>
    pushApi
      .status(installationId(env))
      // No borra el error de una acción: el aviso de fallo debe seguir visible.
      .then(setStatus)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(kind: Busy, action: () => Promise<string | null>) {
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      const done = await action();
      if (done) setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la acción.');
    } finally {
      setPermission(env.notification?.permission ?? 'default');
      await refresh();
      setBusy(null);
    }
  }
  const enable = () =>
    run('enable', async () => {
      const result = await enablePush(env, pushApi);
      if (!result.ok) throw new Error(result.message);
      return 'Notificaciones activadas en este dispositivo.';
    });
  const disable = () =>
    run('disable', async () => {
      await disablePush(env, pushApi);
      return 'Notificaciones desactivadas en este dispositivo.';
    });
  const test = () =>
    run('test', async () => {
      await pushApi.test();
      return 'Enviamos una notificación de prueba a tus dispositivos activos.';
    });

  const active = Boolean(status?.device?.active) && permission === 'granted';
  const ios = isIos(env);
  return (
    <section className="push-settings">
      {!status && !error && <ListSkeleton label="Cargando notificaciones…" count={1} />}
      {status && (
        <div className={`push-card ${active ? 'is-on' : ''}`} role="status">
          <span className="push-dot" aria-hidden="true" />
          <div>
            <strong>
              {active ? 'Activadas en este dispositivo' : 'Desactivadas en este dispositivo'}
            </strong>
            <p>
              {active && status.device?.label}
              {active && status.device?.lastSuccessAt
                ? ` · último aviso: ${date(status.device.lastSuccessAt)}`
                : ''}
              {!active &&
                (status.activeDevices
                  ? `Tu cuenta tiene ${status.activeDevices === 1 ? '1 dispositivo activo' : `${status.activeDevices} dispositivos activos`}.`
                  : 'Ningún dispositivo de tu cuenta recibe avisos.')}
            </p>
            {!active && status.device?.failureReason && (
              <p className="push-warning">{status.device.failureReason}</p>
            )}
          </div>
        </div>
      )}
      {status && !status.receivesNotifications && (
        <p className="push-help">Tu rol todavía no recibe avisos automáticos.</p>
      )}
      {status && !status.configured && (
        <p className="push-help push-warning" role="alert">
          El servidor aún no tiene configuradas las notificaciones. Falta añadir las claves VAPID
          (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT) en el entorno de la API.
        </p>
      )}
      <SupportHelp support={support} ios={ios} />
      {support.kind === 'supported' && permission === 'denied' && (
        <div className="push-help push-warning" role="alert">
          <strong>Las notificaciones están bloqueadas para Instafix.</strong>
          {ios ? (
            <p>
              Para permitirlas: abre <b>Ajustes</b> del iPhone → <b>Notificaciones</b> → busca{' '}
              <b>Instafix</b> → activa <b>Permitir notificaciones</b>. Después vuelve aquí y pulsa
              «Activar notificaciones».
            </p>
          ) : (
            <p>
              Para permitirlas, abre los ajustes del sitio en tu navegador (el icono junto a la
              dirección), permite las notificaciones para este sitio y recarga la página.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="admin-message" role="status">
          {notice}
        </p>
      )}
      {support.kind === 'supported' && status?.configured && (
        <div className="push-actions">
          {!active && permission !== 'denied' && (
            <BusyButton
              type="button"
              className="btn btn-primary"
              busy={busy === 'enable'}
              disabled={busy !== null}
              busyLabel="Activando…"
              onClick={() => void enable()}
            >
              Activar notificaciones
            </BusyButton>
          )}
          {active && (
            <>
              <BusyButton
                type="button"
                className="btn btn-secondary"
                busy={busy === 'test'}
                disabled={busy !== null}
                busyLabel="Enviando…"
                onClick={() => void test()}
              >
                Enviar prueba
              </BusyButton>
              <BusyButton
                type="button"
                className="btn btn-ghost"
                busy={busy === 'disable'}
                disabled={busy !== null}
                busyLabel="Desactivando…"
                onClick={() => void disable()}
              >
                Desactivar en este dispositivo
              </BusyButton>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SupportHelp({ support, ios }: { support: Support; ios: boolean }) {
  if (support.kind === 'supported') return null;
  if (support.kind === 'ios-install')
    return (
      <p className="push-help" role="note">
        <strong>En iPhone, primero instala Instafix en la pantalla de inicio</strong> (pasos en
        «App», arriba) y ábrela desde ese icono. Requiere iOS 16.4 o posterior.
      </p>
    );
  if (support.kind === 'ios-update')
    return (
      <p className="push-help push-warning" role="note">
        Este {ios ? 'iPhone o iPad' : 'dispositivo'} no admite notificaciones web. Actualiza a iOS
        16.4 o posterior y abre Instafix desde la pantalla de inicio.
      </p>
    );
  if (support.kind === 'insecure')
    return (
      <p className="push-help push-warning" role="note">
        Las notificaciones solo funcionan con conexión segura (https://).
      </p>
    );
  return (
    <p className="push-help push-warning" role="note">
      Este navegador no admite notificaciones push. Prueba con Safari (iPhone, desde la pantalla de
      inicio), Chrome, Edge o Firefox.
    </p>
  );
}
