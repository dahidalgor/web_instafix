# Reserva propia con Cal.com API v2 (17 de octubre de 2026)

InstaFix controla toda la experiencia de reserva. Cal.com queda como **motor de agenda** (disponibilidad, calendarios conectados, conflictos y reservas) y nunca aparece ante el cliente.

```text
Cliente → React (calendario propio) → NestJS /api/v1 → PostgreSQL (fuente de verdad) → Cal.com API v2
                                                    ↑
                         Cal.com → webhook firmado ─┘
```

La clave de Cal.com solo existe en el servidor. React nunca la recibe ni llama a Cal.com.

## Flujo del cliente

1. **Fecha y hora.** Calendario mensual propio (lunes primero, zona `America/Guayaquil`). Los días con horarios salen de Cal.com. Al elegir un día se piden sus horarios sin caché.
2. **Solicitud.** El cliente describe qué necesita (10–1000 caracteres). No elige equipo ni servicio.
3. **Contacto.** Solo para invitados: nombre, apellido, WhatsApp y correo. Con sesión iniciada se omite.
4. **Resumen.** Muestra fecha, hora, solicitud y contacto. El WhatsApp de una cuenta aparece enmascarado (`+593 98 *** **19 🔒`) y no se puede editar. El cliente autoriza el contacto por WhatsApp.
5. **Confirmación.** Con cuenta: «Ver en Mis citas». Como invitado: «Crear mi cuenta», con el registro ya rellenado.

Si el horario se ocupa mientras el cliente completa el formulario, vuelve al paso 1 con el aviso «Las HH:MM acaban de dejar de estar disponibles» y los horarios actualizados. Los demás datos se conservan.

Si un invitado usa el WhatsApp de una cuenta existente, ve el mensaje «Ya existe una cuenta asociada a este número de WhatsApp. Inicia sesión para agendar tu cita.» y un botón para iniciar sesión. El borrador se guarda en `sessionStorage` y, al iniciar sesión, vuelve a la agenda.

Si el servidor no tiene `CAL_API_KEY`/`CAL_EVENT_TYPE_ID`, o `BOOKING_MODE=legacy`, la agenda muestra el formulario anterior (`LegacyCalendar.tsx`). Es la red de seguridad durante la migración. Ver [Retirar el formulario anterior](#retirar-el-formulario-anterior).

## API

| Método | Ruta                                                           | Uso                                                                                                 |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/booking/config`                                       | Modo (`native`/`legacy`) y datos **enmascarados** de la sesión                                      |
| GET    | `/api/v1/booking/availability?start=YYYY-MM-DD&end=YYYY-MM-DD` | Horarios por día (máx. 62 días; caché de 30 s salvo consultas de un solo día)                       |
| POST   | `/api/v1/booking/appointments`                                 | Crear la cita (`requestKey`, `start`, `customerRequest`, `whatsappConsent`, `guest` solo invitados) |
| GET    | `/api/v1/appointments/me`                                      | `{ upcoming, history }` del usuario de la sesión                                                    |
| GET    | `/api/v1/appointments/me/:id`                                  | Detalle propio (404 si es de otra persona)                                                          |
| GET    | `/api/v1/appointments/me/:id/availability`                     | Horarios para reprogramar (excluye la propia reserva)                                               |
| POST   | `/api/v1/appointments/me/:id/cancel`                           | Cancelar (Cal.com primero, luego PostgreSQL)                                                        |
| POST   | `/api/v1/appointments/me/:id/reschedule`                       | Reprogramar (`requestKey`, `start`)                                                                 |

Errores con código estable en `code`: `ACCOUNT_EXISTS`, `SLOT_TAKEN`, `INVALID_EMAIL`, `IN_PROGRESS`, `UNCERTAIN`, `PROVIDER_UNAVAILABLE`, `REJECTED`, `NOT_ALLOWED`, `NOT_CONFIGURED`.

`GET /api/v1/my/appointments` se conserva por compatibilidad. La web ya no lo usa.

## Reglas de identidad y seguridad

- **El propietario sale siempre de la cookie de sesión** (`authenticated(req)`). Ningún endpoint acepta `userId` del navegador. El esquema de creación descarta las claves desconocidas.
- **Con sesión**, nombre, teléfono y correo se leen de `User` en PostgreSQL. `guest`, `phone` o cualquier dato enviado se ignora. La prueba de integración lo comprueba con un teléfono y un `userId` falsificados.
- **Invitados.** El teléfono se normaliza a E.164 con libphonenumber (por defecto Ecuador). Si existe un `User` con ese número, la API responde `409 ACCOUNT_EXISTS` antes de tocar Cal.com. Esto se comprueba en el servidor y no depende de React.
- **Propiedad de citas.** Las consultas filtran por `{ id, userId }`. Una cita ajena responde 404, igual que una inexistente.
- **Teléfonos únicos.** `User.phone` ya era `@unique` y se guarda en E.164. `User.phoneVerifiedAt` ya existe para la futura verificación por WhatsApp.
- Cookies HttpOnly/SameSite=Strict y `checkOrigin` en todas las escrituras. Hay límites de frecuencia: 60/min para disponibilidad y 10/min para crear, cancelar o reprogramar.
- Los datos editados en Cal.com (nombre, teléfono, correo) **nunca** cambian el contacto de una cita creada por InstaFix.

## Consistencia PostgreSQL ↔ Cal.com

Orden de operaciones al confirmar:

1. Validar los datos y resolver el contacto (cuenta o invitado).
2. Comprobar la idempotencia: si `bookingKey` ya existe, devolver el resultado conocido sin volver a crear nada.
3. **Revalidar el horario** contra Cal.com en ese instante. Si ya no está libre, responder `SLOT_TAKEN` sin crear nada.
4. Insertar la cita en estado `CREATING` con `bookingKey` único. Un doble clic simultáneo choca con la restricción única.
5. Crear la reserva en Cal.com con `metadata.instafixAppointmentId`.
6. Guardar `calUid`, horario real y estado (`accepted` → `CONFIRMED`, `pending` → `PENDING_LOCATION`) y emitir eventos.

Fallos:

| Situación                                      | Resultado                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cal.com rechaza y el horario ya no está libre  | Cita `FAILED` (`SLOT_TAKEN`) y aviso al cliente para elegir otro horario                                                                                                               |
| Cal.com rechaza el correo                      | `FAILED` (`INVALID_EMAIL`) y vuelta al paso de contacto                                                                                                                                |
| Timeout o 5xx después de enviar                | Queda `CREATING` con `bookingError=UNCERTAIN`. **Nunca se muestra «Cita creada»**. El reintento con la misma clave **concilia** (busca en Cal.com por metadata) y vincula sin duplicar |
| Cal.com crea, pero PostgreSQL falla al guardar | El webhook `BOOKING_CREATED` encuentra la cita por metadata y la completa. El reintento con la misma clave también                                                                     |
| Cancelar o reprogramar                         | Primero Cal.com. Si falla, PostgreSQL no cambia                                                                                                                                        |

Las citas `FAILED` no aparecen en Mi cuenta.

## Base de datos (migración `20261017120000_instafix_booking`)

Solo añade elementos; no borra ni reescribe datos.

- `AppointmentStatus`: nuevos `CREATING`, `FAILED` (internos), `RESCHEDULED` y `NO_SHOW`. Ya existían `PENDING_LOCATION` (se muestra como «Pendiente de confirmación»), `CONFIRMED`, `IN_PROGRESS`, `COMPLETED` y `CANCELLED`. Son estados de la **cita**. El trabajo técnico vive en `CompletedJob`.
- `Appointment` nuevas columnas: `customerRequest` (lo que escribe el cliente), `contactEmail`, `source` (`INSTAFIX` | `CAL_EMBED` | `ADMIN`), `bookingKey` (único, idempotencia), `bookingError`, `cancellationReason`, `calSyncedAt` y `rescheduledFromId` (único, autorrelación «reprogramada a»).
- Índice `Appointment(status, createdAt)`.
- Tabla `AppointmentEvent` (outbox): `dedupeKey` único, `type`, `payload`, `occurredAt`, `processedAt`. Índice `(processedAt, occurredAt)`.
- Datos previos: `customerRequest = title` en reservas de Cal y `source = 'ADMIN'` en citas sin `calUid`.

**Solicitud ≠ trabajo realizado.** `customerRequest` es lo que el cliente pidió. `offeringId`/`device` los asigna el técnico en Administración → Citas. El trabajo y la garantía se registran en `CompletedJob` (Administración → Trabajos). Una cita reservada en la web queda con `device = 'Por especificar'` hasta que el técnico la clasifica.

## Cal.com

Endpoints y versiones (revisados en la documentación oficial el 17/10/2026, fijados en `integrations/cal-api.ts`):

| Uso                            | Endpoint                                                                             | `cal-api-version` |
| ------------------------------ | ------------------------------------------------------------------------------------ | ----------------- |
| Horarios                       | `GET /v2/slots?eventTypeId&start&end&timeZone&format=range[&bookingUidToReschedule]` | 2024-09-04        |
| Crear                          | `POST /v2/bookings`                                                                  | 2026-02-25        |
| Consultar                      | `GET /v2/bookings/{uid}`                                                             | 2026-02-25        |
| Cancelar                       | `POST /v2/bookings/{uid}/cancel`                                                     | 2026-02-25        |
| Reprogramar                    | `POST /v2/bookings/{uid}/reschedule`                                                 | 2026-02-25        |
| Confirmar (WhatsApp/ubicación) | `POST /v2/bookings/{uid}/confirm`                                                    | 2026-02-25        |
| Conciliar                      | `GET /v2/bookings?eventTypeId&attendeeEmail&afterStart&beforeEnd`                    | 2026-05-01        |

`CAL_API_VERSION` ya no se usa: cada endpoint lleva su versión.

Evento usado: **`agenda-tu-cita-con-instafix` (ID 7271527)**, revisado por API el 17/10/2026. Tiene 120 min, 45 min de margen posterior, intervalo de 60 min, 120 min de antelación mínima, ubicación «address» del organizador y la confirmación **desactivada**: las reservas quedan aceptadas al momento. Campos obligatorios: nombre, correo, `attendeePhoneNumber` y `notes` («¿Qué trabajo requiere?»). La API envía la solicitud del cliente en `bookingFieldsResponses.notes` (configurable con `CAL_REQUEST_FIELD`). El consentimiento de WhatsApp se guarda en `Appointment.whatsappConsentAt`.

Prueba real autorizada (17/10/2026): se creó una reserva marcada PRUEBA desde el script `src/dev/cal-live-check.ts` y otra desde la web. Ambas se consultaron, se conciliaron por metadata, se reprogramaron o cancelaron, y Cal.com liberó el horario. Solo se usaron horarios lejanos y no quedó ninguna activa.

## Webhooks

`POST /api/v1/webhooks/cal` verifica HMAC-SHA256 (`x-cal-signature-256`) sobre el cuerpo original. Deduplica por `IntegrationEvent` y serializa con un bloqueo de PostgreSQL.

- Las reservas con `source = 'INSTAFIX'` (o con `metadata.instafixAppointmentId`) se sincronizan en `cal-webhook-instafix.ts`: completan una cita `CREATING`, marcan `CONFIRMED` al aceptarse, `CANCELLED` al cancelarse o rechazarse, y crean la fila nueva si se reprograma desde Cal.com (por ejemplo, desde el enlace del correo).
- `BOOKING_NO_SHOW_UPDATED` → `NO_SHOW` (o vuelve a `CONFIRMED` si se desmarca).
- Las reservas del formulario anterior siguen su flujo existente. La reprogramación ahora marca la anterior como `RESCHEDULED` en vez de `CANCELLED`.

Activar en Cal.com → Settings → Developer → Webhooks:

- URL `https://instafix.ec/api/v1/webhooks/cal`, con un secreto aleatorio igual a `CAL_WEBHOOK_SECRET`.
- Eventos: `BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED` y `BOOKING_NO_SHOW_UPDATED`.

En local el webhook no puede llegar (localhost). La web propia no depende de él para mostrar la cita, porque la guarda al crearla.

## Eventos para la mensajería (siguiente bloque)

Cada cambio escribe en `AppointmentEvent`, en la misma transacción:

- Ya se emiten: `appointment.created`, `appointment.confirmed`, `appointment.rescheduled`, `appointment.cancelled` y `appointment.no_show`.
- Reservados en `appointment-events.ts`, todavía sin emitir: `appointment.reminder`, `technician.assigned` y `technician.on_the_way`.

Ningún proceso los consume todavía (`processedAt = null`). El bloque de WasapFlow deberá leerlos y marcarlos. El código de WasapFlow existente no se tocó. Las citas del formulario anterior siguen usando la cola `AutomationJob` existente (desactivada con `WHATSAPP_ENABLED=false`). Al integrar WasapFlow conviene unificar ambas vías para evitar mensajes duplicados.

## Correos

- **Cal.com** envía la confirmación, cancelación y reprogramación al asistente y al organizador, también cuando la reserva se crea por API. Es la única confirmación de cita que recibe el cliente.
- **InstaFix (Brevo)** solo envía la verificación de cuenta y la recuperación de contraseña. No envía confirmaciones de cita, así que no hay duplicados.
- Cal.com rechaza correos sin buzón válido (`This email address cannot receive mail`). La web lo muestra como «Ese correo no puede recibir mensajes».
- Pendiente para el bloque de correo: decidir si InstaFix envía su propia confirmación con su marca y, en ese caso, desactivar los correos al asistente en Cal.com (Event type → Advanced) para no duplicar.

## Vincular reservas de invitados (preparado, no activo)

Hoy una reserva de invitado queda con `userId = null` y `contactPhone` en E.164 (indexado). **No** se vincula a una cuenta solo porque coincida el teléfono escrito. Cuando exista la verificación OTP por WhatsApp (`User.phoneVerifiedAt`):

1. Tras verificar el teléfono, en una transacción: `UPDATE "Appointment" SET "userId" = :user WHERE "userId" IS NULL AND "contactPhone" = :phoneVerificado AND "source" IN ('INSTAFIX','CAL_EMBED')`.
2. Registrar un evento de auditoría por cada cita vinculada.
3. Mientras tanto, administración puede vincular manualmente (Administración → Citas → «Vincular a Mi cuenta»).

## Variables de entorno

| Variable             | Local                                      | Producción                           |
| -------------------- | ------------------------------------------ | ------------------------------------ |
| `CAL_API_KEY`        | Sí (ya configurada en tu `.env`)           | Sí                                   |
| `CAL_EVENT_TYPE_ID`  | `7271527` (ya configurado)                 | `7271527`                            |
| `CAL_WEBHOOK_SECRET` | Opcional (el webhook no llega a localhost) | Sí                                   |
| `BOOKING_MODE`       | Opcional (`legacy` para volver al iframe)  | Opcional                             |
| `CAL_REQUEST_FIELD`  | Opcional (`notes`)                         | Opcional                             |
| `CAL_API_BASE_URL`   | Solo para el simulador                     | **No usar**: se ignora en producción |
| `CAL_API_VERSION`    | Ya no se usa; puede quedarse               | Ya no se usa                         |

## Desarrollo y pruebas

```sh
pnpm --filter @instafix/api cal:simulator          # Cal.com simulado en :3999 (sin agenda real)
CAL_API_BASE_URL=http://127.0.0.1:3999/v2 CAL_API_KEY=cal_test_simulator CAL_EVENT_TYPE_ID=4242 pnpm dev

pnpm test                                           # unitarias (incluye cliente Cal contra el simulador)
INSTAFIX_INTEGRATION=1 INSTAFIX_TEST_DISABLE_THROTTLE=1 \
  pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 src/tests/booking.integration.test.ts

# Comprobación real controlada (crea, reprograma y cancela UNA reserva lejana):
pnpm --filter @instafix/api exec tsx src/dev/cal-live-check.ts --confirm-real-booking --email <correo-real> --phone +593...
```

`booking.integration.test.ts` usa PostgreSQL local y el simulador. Cubre: teléfono manipulado con sesión, invitado con el WhatsApp de una cuenta (también en formato local), normalización E.164, idempotencia y doble clic, horario tomado antes de revalidar y dentro de Cal.com, respuesta perdida con conciliación, propiedad entre usuarios (404), webhook firmado e idempotente, cancelación, reprogramación desde la web y desde Cal.com, no-show y orden de Próximas e Historial.

## Retirar el formulario anterior

Cuando la reserva propia lleve unos días en producción sin incidencias:

1. Eliminar `LegacyCalendar.tsx`, `@calcom/embed-react`, `POST /booking/context`, `BookingIntent` y la identidad por referencia (`booking-identity.ts`) en una migración aparte.
2. Mantener el webhook: sigue siendo necesario para cambios hechos desde Cal.com.

## Pendiente fuera de este bloque

- Integrar WasapFlow consumiendo `AppointmentEvent` (siguiente bloque).
- Verificación OTP por WhatsApp y vinculación automática de citas de invitados.
- Rediseño de correos y deliverability.
- La dirección del cliente sigue llegando por WhatsApp. No se valida la cobertura geográfica.
- Administración no confirma ni reprograma desde su panel. Se hace en Cal.com, y el webhook sincroniza.
