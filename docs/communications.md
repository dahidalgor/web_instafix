# Comunicaciones, verificación de cuentas y agenda · 17 de octubre de 2026

## Arquitectura

```text
CALENDARIO   Cliente → Instafix (API) → Cal.com API v2          (solo disponibilidad y reservas)
EMAIL        Instafix → EmailService → SmtpEmailProvider → Brevo → Cliente
WHATSAPP     Instafix → WhatsAppService / WhatsAppOtpProvider → WasapFlow Bridge → WABA Instafix → Cliente
```

- `mail/email.service.ts`: único punto de envío de correo (`sendEmail`). Registra cada intento en `CommunicationLog` con destinatario enmascarado. Si Brevo no acepta el mensaje lanza un error: ningún llamador afirma un envío no aceptado.
- `mail/templates.ts`: verificación de correo, recuperación de contraseña, cita creada, reprogramada y cancelada. Vistas previas con datos ficticios en `docs/email-previews/`.
- `auth/verification.service.ts`: genera y valida OTP. `whatsapp/otp.provider.ts` solo los transporta (`WasapFlowOtpProvider`). La autenticación no conoce WasapFlow.
- `booking/booking.service.ts`: crea, reprograma y cancela en Cal.com y después persiste en PostgreSQL.
- `notifications/appointment-events.ts`: eventos internos `appointment.created`, `.rescheduled`, `.cancelled`, `.technician_assigned`, `.technician_on_the_way`. Deciden los canales: correo (bandeja `Notification`) y WhatsApp (cola `AutomationJob`). Los OTP no pasan por aquí.
- `notifications/notification.service.ts`: bandeja durable con clave única por hecho y worker de reintentos.

## Verificación de cuentas

- Cuenta activa ⇔ `phone_verified_at IS NOT NULL`. El correo (`email_verified_at`) es opcional.
- Registro: nombre, correo, WhatsApp y contraseña → OTP `PHONE_VERIFICATION` → al verificar se crea la cuenta con `phoneVerifiedAt` y se abre sesión. Los datos pendientes viven en `PhoneChallenge` (contraseña ya con hash): un registro abandonado no bloquea el número.
- Teléfono normalizado en el backend a E.164 (`0981234519`, `593981234519` y `+593 98 123 4519` → `+593981234519`). `User.phone` es UNIQUE; una carrera entre dos registros termina con un único usuario y el mensaje «Ya existe una cuenta asociada a este número de WhatsApp», con accesos a iniciar sesión y recuperar contraseña.
- Login con credenciales correctas y WhatsApp sin verificar (cuentas anteriores): `403 PHONE_UNVERIFIED`, se envía un OTP y no se crea sesión ni otra cuenta. Las sesiones antiguas de esas cuentas dejan de valer hasta verificar. Los administradores no están sujetos a este requisito para no perder el acceso administrativo si WasapFlow no está disponible.
- Citas de invitado: solo después del OTP correcto se asocian las reservas con `userId = NULL`, el mismo teléfono normalizado, sin incidencia de identidad y creadas en los últimos 180 días (evita heredar reservas de un número reasignado). Cada vínculo queda en `IntegrationEvent` (`ACCOUNT_LINK`, `PHONE_OTP:<userId>`).

### OTP

| Regla              | Valor                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| Generación         | `crypto.randomInt`, 6 dígitos                                                       |
| Almacenamiento     | hash scrypt con sal; nunca en texto plano ni en logs                                |
| Caducidad          | 10 minutos                                                                          |
| Intentos           | 5 por código                                                                        |
| Reenvío            | cooldown 60 s; máximo 5 códigos por número y hora; el reenvío invalida el anterior  |
| Uso                | único; consumo transaccional con bloqueo por teléfono                               |
| Propósitos         | `PHONE_VERIFICATION`, `PASSWORD_RESET`, `PHONE_CHANGE`, sin intercambio entre ellos |
| Fallo de WasapFlow | la transacción se revierte: no queda código, no se verifica nada, error 503 visible |

Límites por IP (Nest Throttler): registro 5/min, login 10/min, verificar 10/min, reenviar 3/min, recuperar 5/min, completar recuperación 5/min, verificar correo 10/min, enviar verificación 3/min. A esto se suman los límites por número, correo y usuario guardados en PostgreSQL.

## Recuperación de contraseña

- **WhatsApp**: número → OTP `PASSWORD_RESET` (solo si ese número ya está verificado) → token temporal (15 min) → nueva contraseña.
- **Correo**: correo → enlace `#restablecer?token=…` (30 min) solo si `email_verified_at` no es nulo y el correo no cambió.
- El token de recuperación (`AuthToken`, propósito `PASSWORD_RESET`) no es una sesión ni un JWT: un uso, caduca, pertenece al usuario. Completar la recuperación cierra todas las sesiones e invalida otros tokens.
- Respuesta sin enumeración: «Si existe una cuenta verificada asociada a estos datos, recibirás instrucciones para continuar.» Para números o correos no elegibles se crea un desafío señuelo sin envío, con los mismos límites.

## Mi cuenta → Seguridad

WhatsApp (enmascarado, verificado), correo (enmascarado, verificado/sin verificar, «Verificar correo»), contraseña («Cambiar contraseña»).

- Verificar correo: enlace `#verificar-correo?token=…` de 24 h y un uso; si el correo cambia antes de usarlo, el enlace ya no sirve.
- Cambiar correo: requiere contraseña y deja `email_verified_at = NULL`.
- Cambiar WhatsApp: requiere contraseña, comprueba UNIQUE, envía OTP `PHONE_CHANGE` al **nuevo** número y solo entonces cambia el número y `phone_verified_at`.

## Citas y correos de Instafix

| Evento            | Disparador                                                    | Correo                                                                   | WhatsApp                                                             |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Creada            | API Instafix tras crear en Cal.com y guardar en PostgreSQL    | «Tu cita está confirmada» / «Tu cita fue agendada» si falta la ubicación | Solicitud de ubicación existente (`instafix_solicitar_ubicacion`)    |
| Reprogramada      | API Instafix o webhook `BOOKING_RESCHEDULED` hecho en Cal.com | Fecha anterior y nueva                                                   | `instafix_cita_reprogramada` si está configurada                     |
| Cancelada         | API Instafix o webhook `BOOKING_CANCELLED`/`BOOKING_REJECTED` | «Tu cita fue cancelada»                                                  | `instafix_cita_cancelada` si está configurada                        |
| Técnico asignado  | Administración cambia el técnico                              | —                                                                        | `instafix_tecnico_asignado`                                          |
| Técnico en camino | Botón en Administración → Citas                               | —                                                                        | `instafix_tecnico_en_camino`                                         |
| Recordatorio      | 08:00 Ecuador                                                 | —                                                                        | `instafix_recordatorio_visita` (texto nuevo) o la plantilla anterior |

El correo muestra «Solicitud: “…”» con lo que describió el cliente; nunca un servicio realizado. Los invitados reciben «Tu cita ha sido creada correctamente» y una invitación a crear la cuenta con el mismo WhatsApp, sin botón que exija iniciar sesión.

**Sin duplicados**: cada correo tiene una clave única (`email:<cita>:APPOINTMENT_CREATED`, `…:APPOINTMENT_CANCELLED`, `…:APPOINTMENT_RESCHEDULED:<nuevo inicio>`). La API y el webhook usan el mismo bloqueo de PostgreSQL; si el webhook llega antes que la respuesta de Cal.com, la API completa la misma fila. Los webhooks de reservas creadas por Instafix (`source = INSTAFIX_API`) solo actualizan el estado de Cal.com. Si Cal.com falla, no se guarda la cita ni se envía nada; si falla PostgreSQL después de crear en Cal.com, se cancela esa reserva.

**Activación**: `APPOINTMENT_EMAILS_ENABLED=false` por defecto, para no duplicar con Cal.com mientras siga enviando sus correos.

## Cal.com: qué enviaba y cómo se desactiva

Con el calendario incrustado, el cliente escribía su correo dentro de Cal.com, y Cal.com le enviaba: solicitud recibida (evento con «requiere confirmación»), confirmación al aceptar, reprogramación y cancelación, además de cualquier Workflow configurado (email/SMS/WhatsApp). Según la documentación de Cal.com, el correo de confirmación al asistente solo puede desactivarse si existe un Workflow que lo sustituya, y los de reprogramación/cancelación no se pueden desactivar por evento ([ayuda](https://cal.com/help/event-types/disable-confirmation), [issue #13947](https://github.com/calcom/cal.com/issues/13947)).

Solución implementada: la web ya no usa el iframe. Instafix crea la reserva por API y entrega a Cal.com como correo del asistente un buzón propio (`CAL_ATTENDEE_RELAY_EMAIL`). El correo real del cliente queda solo en PostgreSQL. Así Cal.com no puede escribirle por correo, sea cual sea la configuración del evento. El teléfono sí se entrega (campo `attendeePhoneNumber`), por eso los Workflows de SMS/WhatsApp de Cal.com deben desactivarse a mano.

No se han eliminado tipos de evento ni calendarios. La disponibilidad, la sincronización de calendario y los webhooks siguen en Cal.com.

## Pruebas automatizadas

```sh
pnpm test
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 \
  src/tests/otp-auth.integration.test.ts src/tests/booking-communications.integration.test.ts
```

Usan PostgreSQL de desarrollo, WasapFlow/Brevo/Cal.com simulados en memoria y datos temporales que se eliminan. `dependency-injection.test.ts` arranca el módulo Nest con `tsx` (como en producción) y falla si alguna dependencia queda sin inyectar.

Prueba manual local sin WhatsApp real: `NODE_ENV=development WHATSAPP_OTP_PROVIDER=console WHATSAPP_OTP_ENABLED=true` imprime el código en la consola de la API. Fuera de `NODE_ENV=development` ese proveedor está bloqueado.

Prueba real controlada de la plantilla OTP (un código aleatorio que no valida ninguna cuenta):

```sh
pnpm --filter @instafix/api whatsapp:test --to +5939XXXXXXXX --otp          # simulación
WHATSAPP_OTP_ENABLED=true pnpm --filter @instafix/api whatsapp:test --to +5939XXXXXXXX --otp --send
```

Correo real controlado: Administración → Comunicaciones → «Enviar prueba real». «Aceptado» significa que Brevo recibió el mensaje; la llegada a la bandeja se comprueba en el buzón y en los registros de Brevo.
