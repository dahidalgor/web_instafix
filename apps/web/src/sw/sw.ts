/// <reference lib="webworker" />
import { openNotificationTarget, payloadFromEvent, showStaffNotification } from './handlers';

/**
 * Service worker de Instafix (solo se registra en el panel del equipo, al activar avisos).
 * Responsabilidades: recibir Web Push y abrir el panel al tocar el aviso.
 * No intercepta peticiones (sin `fetch`) ni guarda caché: la web se sirve como siempre.
 */
declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  // Una versión nueva del worker entra en servicio sin esperar a cerrar las pestañas.
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const data = event.data;
  const payload = payloadFromEvent(data ? () => data.text() : null);
  // iOS exige mostrar una notificación por cada push recibido.
  event.waitUntil(showStaffNotification(self.registration, payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    openNotificationTarget(self.clients, self.location.origin, event.notification.data),
  );
});
