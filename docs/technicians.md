# Técnicos, confirmación de citas y servicios realizados · 18 de octubre de 2026

## Roles

Un solo sistema de usuarios y sesiones (`User` + `Session`, cookie `instafix_session`, contraseñas scrypt). El equipo administrativo son los roles `ADMIN` y `TECHNICIAN`:

```text
Role
├── CUSTOMER     clientes (Mi cuenta)
├── ADMIN        administración completa (admin.instafix.ec)
└── TECHNICIAN   panel técnico (admin.instafix.ec, sin administración)
```

- `User.active`: un miembro desactivado no inicia sesión y sus sesiones abiertas se rechazan (también se borran al desactivarlo o cambiarle la contraseña).
- `authenticated(req, true)` sigue siendo **solo ADMIN**: los 28 endpoints administrativos existentes quedan prohibidos para técnicos sin tocarlos uno a uno.
- `authenticatedStaff(req)` acepta ADMIN o TECHNICIAN y devuelve la identidad de la sesión. Ningún endpoint del equipo acepta un `technicianId` del navegador.
- Los técnicos los crea un administrador en **Administración → Equipo** (nombre, apellido, teléfono, correo opcional, contraseña inicial de 12+ caracteres). Desde ahí no se crean administradores ni se edita la propia cuenta. El script `admin:create` sigue siendo la única vía para crear administradores.

| Acción                                                       | CUSTOMER                    | TECHNICIAN                             | ADMIN |
| ------------------------------------------------------------ | --------------------------- | -------------------------------------- | ----- |
| Panel técnico (`/staff/*`)                                   | ✕ 403                       | ✓                                      | ✓     |
| Ver citas pendientes sin asignar                             | ✕                           | ✓ (sin teléfono ni correo del cliente) | ✓     |
| Confirmar (= asignarse)                                      | ✕                           | ✓                                      | ✓     |
| Ver / gestionar una cita                                     | solo las suyas en Mi cuenta | solo las asignadas a él                | todas |
| Servicios realizados, notas, completar                       | ✕                           | solo en sus citas                      | todas |
| Administración (`/admin/*`), equipo, configuración, secretos | ✕                           | ✕ 403                                  | ✓     |

## Estados y flujo

`PENDING_LOCATION` se muestra como **«Pendiente de confirmación»**: es el único estado pendiente (no se añadió otro valor para no romper la agenda, los webhooks ni la cola de WhatsApp). La ubicación es un dato aparte (`locationReceivedAt`).

```text
Cliente agenda ──► PENDING_LOCATION («Pendiente de confirmación»)
                   ├─ reserva provisional SOLO en Instafix (Cal.com no recibe nada todavía)
                   ├─ correo «Recibimos tu solicitud de visita»
                   ├─ WhatsApp pidiendo la ubicación (si autorizó)
                   └─ avisos push a técnicos hasta que alguien confirme (ver más abajo)
Cliente envía ubicación ──► se guarda dirección/coordenadas (ya NO confirma la visita)
Técnico pulsa «Confirmar cita»
  ├─ identidad desde la sesión · rol ADMIN/TECHNICIAN
  ├─ bloqueo de la cita + UPDATE … WHERE status = PENDING_LOCATION AND assignedTechnicianId IS NULL
  ├─ reserva provisional → se crea la reserva en Cal.com (si Cal.com ya no tiene ese horario,
  │   no se confirma: 409 y la cita queda marcada para que administración cambie la hora)
  ├─ CONFIRMED · assignedTechnicianId · technician (nombre) · confirmedAt · confirmedById
  ├─ auditoría CONFIRMED
  ├─ evento appointment.confirmed ─► correo «Tu visita está confirmada ✓» (Brevo)
  │                                 ─► WhatsApp «cita confirmada» + recordatorios
  └─ tras guardar: Cal.com /bookings/{uid}/confirm (si falla, se reintenta solo)
Técnico registra servicios y notas ──► «Marcar como completada» (con confirmación)
  └─ COMPLETED · completedAt · completedById · evento appointment.completed
Reprogramar ──► vuelve a «Pendiente de confirmación», sin técnico y como reserva provisional:
               su reserva en Cal.com se cancela (auditoría UNASSIGNED_BY_RESCHEDULE). Administración
               puede conservar al técnico: entonces se mueve en Cal.com y sigue confirmada.
Nadie confirma a tiempo / el cliente no responde ──► CANCELLED automática (autoCancelReason)
```

### Reserva provisional y cancelación automática

El horario de una cita que nadie confirmó se guarda solo en Instafix (`holdStartedAt`,
`holdExpiresAt`, `responseDueAt`; ver `apps/api/src/booking/hold.ts`). La web descuenta esas
reservas de los horarios de Cal.com, y dos clientes no pueden tomar el mismo horario.

| Plazo                                            | Duración                                                         | Si vence        |
| ------------------------------------------------ | ---------------------------------------------------------------- | --------------- |
| Técnico confirma                                 | 4 h activas desde que se agenda; como tarde 3 h antes de la cita | Se cancela sola |
| Cliente responde (ubicación o cualquier mensaje) | 2 h activas desde que sale el WhatsApp inicial                   | Se cancela sola |

- **Horas activas**: 07H00–22H00 de Ecuador. De noche no corren los plazos ni salen avisos.
- Un horario que no deja al menos 30 min activos para confirmar no se ofrece ni se acepta.
- Al cancelarse sola: estado `CANCELLED`, `autoCancelReason`, auditoría `AUTO_CANCELLED`, correo y
  WhatsApp «cita cancelada» (con la plantilla aprobada; solo con autorización del cliente).
- Sin autorización de WhatsApp no hay plazo del cliente (nunca recibe el mensaje).
- Una vez confirmada por un técnico, ya no vence.
- Reservas hechas directo en Cal.com, reprogramadas desde Cal.com y las pendientes anteriores a este
  cambio: el barrido les da plazo desde que las ve y, al vencer, también se cancelan en Cal.com.
- Las citas creadas a mano por administración (sin agenda) no vencen.
- El barrido corre cada minuto en `NotificationWorker` (`sweepBookingHolds`).

### Horarios ocupados de los técnicos

Cada técnico marca en **Horarios** (menú «Más» del panel) las horas en que no puede atender
visitas: cada semana (uno o varios días, con fecha «hasta» opcional, p. ej. fin de semestre) o
un día concreto, por horas o todo el día (`TechnicianBusyBlock`, hora de Ecuador). Con eso:

- **Avisos**: «Nueva solicitud» y los recordatorios para confirmar llegan solo a los técnicos
  libres en el horario de la cita (sin horario ocupado ni otra visita que se cruce);
  administración los recibe siempre. Si el técnico marca el horario después, el aviso pendiente
  se anula al enviarse.
- **Pendientes**: cada técnico ve solo las solicitudes de horarios en que está libre. Si abre una
  por enlace, ve el motivo y no puede confirmarla (409); administración sí puede.
- **Web**: un horario en que ningún técnico está libre no se ofrece ni se acepta (si no hay
  ningún técnico registrado, no se restringe). Administración puede mover una cita ahí.
- **Administración**: cada cita pendiente muestra «Técnicos libres» (o «Ninguno»).
- Las visitas ya confirmadas no cambian; al guardar un horario que choca con una, se avisa al
  técnico para que hable con administración.
- API: `GET/POST /api/v1/staff/busy`, `DELETE /api/v1/staff/busy/:id` (solo los propios).

**Avisos para confirmar** (`CONFIRMATION_REMINDER`, push): a los 10 min, a los 30 min y luego cada
30 min de tiempo activo, a los técnicos libres en ese horario con dispositivo. A 30 min del vencimiento,
«Última oportunidad», también a administración. Se anulan solos si alguien confirma o la cita
cambia.

**Concurrencia**: dos técnicos que confirman a la vez se serializan con `pg_advisory_xact_lock` por cita y la actualización condicional; solo uno la obtiene, el otro recibe 409 «Esta cita acaba de ser confirmada por otro técnico.». Repetir la confirmación del ganador devuelve el mismo resultado sin publicar otro evento.

**Idempotencia**: un evento por confirmación; el correo tiene clave única `email:<cita>:APPOINTMENT_CONFIRMED:<confirmedAt>` y el WhatsApp `<cita>:<revisión>:CONFIRMED`. Completar dos veces no repite la transición. Un mismo servicio del catálogo no puede añadirse dos veces (se ajusta la cantidad).

## Solicitud ≠ servicio realizado

- `Appointment.title`: lo que escribió el cliente («Mi PS5 se apaga…»). Nunca se sobrescribe.
- `AppointmentService`: lo que el técnico hizo realmente; varias filas por cita.
- `Appointment.technicianNotes`: notas internas. No salen nunca en `my/appointments` ni en correos.

### `AppointmentService`

| Columna                                                | Uso                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `appointmentId`                                        | cita (borrado en cascada)                                                        |
| `offeringId`                                           | servicio del catálogo (NULL si se borra o, en el futuro, servicio personalizado) |
| `nameSnapshot`, `deviceSnapshot`                       | nombre y equipo en el momento de registrarlo                                     |
| `unitPriceMinor`, `quantity`, `totalMinor`, `currency` | precio aplicado, sin depender del catálogo actual                                |
| `warrantyDaysSnapshot`                                 | garantía anunciada en ese momento                                                |
| `addedById`, `createdAt`, `updatedAt`                  | auditoría                                                                        |

Restricciones: `UNIQUE (appointmentId, offeringId)`, `CHECK quantity BETWEEN 1 AND 100`, `CHECK unitPriceMinor >= 0`, `CHECK totalMinor = unitPriceMinor * quantity`.

**Servicios personalizados**: no se implementaron. El técnico usa el catálogo y las notas. El modelo ya admite `offeringId = NULL` con nombre y precio propios si más adelante se decide añadirlos de forma explícita.

### Preparado para garantías (no implementado)

Cada servicio realizado es una fila con fecha (`appointment.completedAt`), cliente (`appointment.userId`), técnico y días de garantía anunciados. Para garantías por servicio bastará con añadir a `AppointmentService` columnas `warrantyStartsAt`, `warrantyEndsAt`, `warrantyTerms` (o una tabla `ServiceWarranty` 1:1) calculadas al completar. El registro manual existente (`CompletedJob`, Administración → Trabajos) sigue funcionando.

### Auditoría

`AppointmentActivity (appointmentId, actorId, action, detail, createdAt)`: `CONFIRMED`, `SERVICE_ADDED`, `SERVICE_QUANTITY`, `SERVICE_REMOVED`, `NOTES_UPDATED`, `COMPLETED`, `UNASSIGNED_BY_RESCHEDULE`. Además, en la cita: `assignedTechnicianId`, `confirmedAt`, `confirmedById`, `completedAt`, `completedById`.

## API

Panel técnico (ADMIN o TECHNICIAN; escrituras con comprobación de origen):

| Método | Ruta                                                 |                                         |
| ------ | ---------------------------------------------------- | --------------------------------------- |
| GET    | `/api/v1/staff/appointments/me`                      | citas asignadas al usuario de la sesión |
| GET    | `/api/v1/staff/appointments/pending`                 | pendientes, sin técnico, no vencidas    |
| GET    | `/api/v1/staff/appointments/:id`                     | detalle (propia o pendiente)            |
| POST   | `/api/v1/staff/appointments/:id/confirm`             | confirmar = asignarse                   |
| POST   | `/api/v1/staff/appointments/:id/cal-sync`            | reintentar la confirmación en Cal.com   |
| POST   | `/api/v1/staff/appointments/:id/services`            | `{ offeringId, quantity }`              |
| PATCH  | `/api/v1/staff/appointments/:id/services/:serviceId` | `{ quantity }`                          |
| DELETE | `/api/v1/staff/appointments/:id/services/:serviceId` |                                         |
| PUT    | `/api/v1/staff/appointments/:id/notes`               | `{ notes }`                             |
| POST   | `/api/v1/staff/appointments/:id/complete`            |                                         |

Equipo (solo ADMIN): `GET /api/v1/admin/staff`, `POST /api/v1/admin/staff`, `PATCH /api/v1/admin/staff/:id` (`{ active?, password? }`).

Modificados: `GET my/appointments` (técnico asignado y servicios; sin notas ni datos internos), `GET admin/appointments` (técnico y servicios), `POST/PATCH admin/services` (portada).

## Cal.com

- Una cita de la web no está en Cal.com hasta que un técnico la confirma: entonces Instafix crea la reserva (`POST /v2/bookings`, con `metadata.instafixAppointmentId` para que el webhook la enlace a la misma cita) y la acepta con `POST /v2/bookings/{uid}/confirm` si quedó pendiente.
- Las reservas hechas directo en Cal.com ya existen: confirmar solo las acepta.
- Si Cal.com falla, la cita queda confirmada en Instafix con la incidencia «pendiente de confirmar en Cal.com» y el worker de notificaciones reintenta cada 2 minutos.
- La API v2 de Cal.com no ofrece (según la documentación disponible) un endpoint para cambiar el título de una reserva; la v1, que lo tenía, se retiró en abril de 2026. Por eso no se escribe «✓ CONFIRMADA — Cliente — Técnico» en el título.

## Panel técnico (web)

`admin.instafix.ec` con un usuario TECHNICIAN abre directamente el panel (sin la administración). Un ADMIN lo ve en la pestaña «Panel técnico» y gestiona técnicos en «Equipo».

- Pestañas Hoy (próxima visita primero; también visitas pasadas sin completar) · Próximas · Pendientes · Historial. En el teléfono, fijas abajo.
- Tarjeta: estado, hora, día, cliente, solicitud, técnico, ubicación y botones («Confirmar cita», «Ver cita»).
- Detalle a pantalla completa: hora, solicitud original, cliente con «Llamar» y «WhatsApp», ubicación con «Cómo llegar», técnico, servicios realizados (búsqueda en catálogo, cantidad − / +, quitar, total), notas internas y «Marcar como completada» con confirmación.

## Pruebas

```sh
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 \
  src/tests/technicians.integration.test.ts src/tests/catalog-media.integration.test.ts
```

Cubren roles (técnico sin acceso a administración, cliente sin acceso al panel, desactivación), alta de técnicos, confirmación con correo único y sincronización con Cal.com simulado, carrera entre técnicos, servicios con instantánea de precio y cantidades, solicitud conservada, notas ocultas al cliente, completar una sola vez, Cal.com caído con reintento, y reglas del carrusel y portada en la API.
