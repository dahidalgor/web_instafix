# Notificaciones push del equipo

Aviso en el iPhone del administrador cuando un cliente solicita una cita, aunque Instafix no esté
abierta:

> **Nueva solicitud de cita**
> Pedro está solicitando una cita para Jueves 24 de octubre a las 12H00.

El texto se genera con los datos reales de la cita: primer nombre del cliente y fecha y hora en la
zona horaria de la cita (`America/Guayaquil`). Si no hay un nombre válido, dice «Un cliente».
El aviso no lleva teléfono, apellidos, correo ni dirección.

## Arquitectura

```
Cita guardada (booking.service / webhook de Cal.com)
  └─ publishAppointmentEvent('appointment.created')        notifications/appointment-events.ts
       └─ enqueueAppointmentRequested(tx, cita)              notifications/staff/staff-notifications.ts
            · reglas: quién recibe cada tipo (staffRecipientRules)
            · una fila en la bandeja «Notification» por destinatario (channel = WEB_PUSH),
              en la MISMA transacción que la cita
NotificationWorker (cada 15 s)                               notifications/notification.service.ts
  └─ deliverNotification → deliverStaffNotification
       · vuelve a comprobar el permiso del destinatario y que la cita siga vigente
       └─ canal WEB_PUSH (StaffChannel)                      notifications/staff/web-push.channel.ts
            └─ web-push → Apple / Google / Mozilla → service worker del dispositivo
Service worker /sw.js                                        apps/web/src/sw/
  · push → muestra la notificación
  · clic → abre o enfoca el panel en /#cita=<id> (solo rutas del mismo origen)
```

- **Hechos de negocio y avisos separados.** Las citas solo publican hechos. Las reglas de
  destinatarios y el texto viven en `staff-notifications.ts`. El canal solo entrega.
- **Bandeja (outbox).** Se reutiliza la tabla `Notification` de los correos; no hay un segundo
  sistema de colas. Como la fila se crea en la transacción de la cita, solo hay aviso si la cita
  quedó guardada. La clave única `web_push:APPOINTMENT_REQUESTED:<cita>:<usuario>` impide
  duplicados entre la respuesta de la API, el webhook de Cal.com y los reintentos con la misma
  `Idempotency-Key`.
- **Un fallo push nunca afecta a la cita.** El envío ocurre después, en el worker, fuera de la
  petición del cliente. Errores temporales: hasta 5 reintentos con espera creciente. Un aviso que
  no se pudo entregar en 24 h se descarta.
- **Contrato de cada aviso** (fila `Notification`): `kind` (tipo de hecho), `recipient` (id del
  usuario), `appointmentId` (entidad), `data` (título, cuerpo y ruta), `channel`, `status`
  (`PENDING`, `RETRY`, `SENDING`, `SENT`, `SUPPRESSED`, `CANCELLED`, `FAILED`), `lastError`
  (motivo del fallo o de la supresión) y `createdAt`. El payload que viaja al dispositivo está en
  `packages/contracts/src/push.ts` (`StaffPushPayload`).
- **Dispositivos.** Tabla `PushSubscription`: un registro por navegador o instalación, varios por
  usuario y hasta 10 activos. El endpoint y las claves nunca se registran en logs ni se devuelven
  al panel.

### Quién recibe qué

| Tipo                      | Destinatarios                           | Estado                         |
| ------------------------- | --------------------------------------- | ------------------------------ |
| `APPOINTMENT_REQUESTED`   | Administradores activos con dispositivo | Implementado                   |
| `APPOINTMENT_CANCELLED`   | Administradores                         | Regla preparada, sin productor |
| `APPOINTMENT_RESCHEDULED` | Administradores                         | Regla preparada, sin productor |
| `APPOINTMENT_ASSIGNED`    | Técnicos                                | Regla preparada, sin productor |

Solo cuenta como solicitud nueva el hecho `appointment.created` de una reserva hecha por el
cliente (estado `PENDING_LOCATION`). Una edición, una reprogramación, una consulta de
disponibilidad o una cita creada desde administración no generan este aviso.

**Avisos a técnicos (siguiente paso).** Por ejemplo, «te asignaron una cita»:

1. Añadir el caso a `publishAppointmentEvent`, por ejemplo `appointment.confirmed`.
2. Llamar a una función que encole el aviso para el técnico asignado, en lugar de para todo un
   rol, con su clave única.

El canal, el worker, el service worker y la pantalla de activación no cambian. Los técnicos ya
pueden registrar dispositivos en la API, aunque la pantalla de activación solo está hoy en
administración.

**Apps nativas (futuro).** Una app de iOS o Android tendrá sus propios tokens (APNs o FCM), no
suscripciones Web Push. Se registrarán en una tabla propia, con un endpoint autenticado parecido.
El canal se implementará como `ApnsChannel` o `FcmChannel` sobre la interfaz `StaffChannel`, con
`channel = 'APNS' | 'FCM'` en la bandeja. Las reglas de destinatarios y la lógica de citas se
reutilizan sin cambios.

## API (sesión de ADMIN o TECHNICIAN)

| Método y ruta                            | Uso                                                     | Límite       |
| ---------------------------------------- | ------------------------------------------------------- | ------------ |
| `GET /api/v1/staff/push?installationId=` | Estado: configuración, clave pública y este dispositivo | 60/min       |
| `PUT /api/v1/staff/push/subscription`    | Registrar o renovar la suscripción de este dispositivo  | 10/min, 60/h |
| `DELETE /api/v1/staff/push/subscription` | Desactivar este dispositivo                             | 10/min, 60/h |
| `POST /api/v1/staff/push/test`           | Aviso de prueba fijo a los propios dispositivos         | 3/min, 10/h  |

- El destinatario es siempre el usuario de la sesión. Un `userId` en el cuerpo se rechaza.
- Las peticiones que modifican algo comprueban el `Origin`.
- Solo se aceptan endpoints `https` de servicios push conocidos, para que el servidor nunca haga
  peticiones a otros hosts: `push.apple.com`, `fcm.googleapis.com`,
  `push.services.mozilla.com` y `notify.windows.com`.
- No existe ningún endpoint para enviar textos arbitrarios.
- Respuestas del servicio push:
  - `404`/`410`: la suscripción caducó y se desactiva.
  - `401`/`403`: claves VAPID cambiadas; se desactiva y hay que volver a activar en el
    dispositivo.
  - `429`/`5xx` o fallo de red: se reintenta.

## Configuración (claves VAPID)

Variables **solo de la API**, nunca `VITE_*`. La clave pública llega al panel por la API; la
privada no sale del servidor.

```sh
VAPID_PUBLIC_KEY=    # 87 caracteres base64url
VAPID_PRIVATE_KEY=   # 43 caracteres base64url — secreta
VAPID_SUBJECT=mailto:avisos@instafix.ec   # mailto: o https:; Apple lo exige
```

Generar un par de claves (una vez por entorno, sin guardarlo en Git):

```sh
pnpm --filter @instafix/api push:keys                 # en local
docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm push:keys   # en el servidor
```

- **Local:** añadir las tres variables a `.env` en la raíz y reiniciar la API.
- **Producción:** añadirlas a mano en `.env.production` en el servidor (el servicio `api` lo lee
  con `env_file`) y reiniciar solo la API. No hace falta reconstruir la web: la clave pública no
  va en el bundle.
- Sin las claves todo sigue funcionando: los avisos esperan en la bandeja, el panel indica que
  falta configuración y el registro de dispositivos responde 503.
- Cambiar las claves invalida todas las suscripciones: cada dispositivo debe volver a pulsar
  «Activar notificaciones».

## Requisitos en iPhone y iPad

- iOS o iPadOS **16.4 o posterior**.
- Instafix **añadido a la pantalla de inicio** y abierto desde ese icono. En una pestaña de Safari
  no existe Web Push. El panel (`admin.instafix.ec`) usa su propio manifiesto con
  `display: standalone`; la web pública no cambia.
- Permiso aceptado. Solo se pide al pulsar «Activar notificaciones», nunca al cargar.
- HTTPS (en producción, Caddy y Cloudflare).
- La suscripción se renueva en silencio cada vez que se abre el panel (sin volver a pedir
  permiso). Si iOS la invalida, el panel mostrará «Desactivadas» y basta con volver a activarla.
- Si se deniega el permiso, se cambia en Ajustes → Notificaciones → Instafix → Permitir
  notificaciones.

## Probar en un iPhone real

1. En Safari, abre `https://admin.instafix.ec` → Compartir → **Añadir a pantalla de inicio**.
2. Abre Instafix **desde el icono**, inicia sesión con una cuenta de administrador y ve a
   **Notificaciones**.
3. Pulsa **Activar notificaciones** y acepta el permiso. Debe aparecer «Activadas en este
   dispositivo · iPhone · Safari».
4. Pulsa **Enviar prueba**. La notificación de prueba debe llegar.
5. **App en segundo plano:** vuelve a la pantalla de inicio. Desde otro dispositivo, reserva una
   cita real de prueba en `instafix.ec` (y cancélala después). En unos 15 segundos debe llegar
   «Nueva solicitud de cita».
6. **Pantalla bloqueada:** bloquea el iPhone y repite el paso 5. El aviso aparece en la pantalla
   bloqueada.
7. Toca el aviso: Instafix se abre en **Citas** con esa cita abierta.

Diagnóstico:

- Filas `Notification` con `channel = 'WEB_PUSH'`: estado y `lastError`.
- Tabla `PushSubscription`: `active`, `lastSuccessAt` y `failureReason`.
- Logs `push.notification` y `push.delivery_failed`, que no incluyen endpoints ni claves.
