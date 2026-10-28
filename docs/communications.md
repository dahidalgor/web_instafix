# Comunicaciones, verificación de cuentas y agenda · 17 de octubre de 2026

## Arquitectura

```text
CALENDARIO   Cliente → Instafix (API) → Cal.com API v2          (solo disponibilidad y reservas)
EMAIL        Instafix → EmailService → SmtpEmailProvider → Brevo → Cliente
WHATSAPP     Instafix → WhatsAppService / WhatsAppOtpProvider → WhatsAppProvider → Bird → Cliente
```

- `mail/email.service.ts`: único punto de envío de correo (`sendEmail`). Registra cada intento en `CommunicationLog` con destinatario enmascarado. Si Brevo no acepta el mensaje lanza un error: ningún llamador afirma un envío no aceptado.
- `mail/templates.ts`: verificación de correo, recuperación de contraseña, cita creada, reprogramada y cancelada. Vistas previas con datos ficticios en `docs/email-previews/`.
- `auth/verification.service.ts`: genera y valida OTP. `whatsapp/otp.provider.ts` solo los transporta (`WhatsAppCodeSender` → proveedor → plantilla `bird_otp`). La autenticación no conoce Bird.
- `booking/booking.service.ts`: crea, reprograma y cancela en Cal.com y después persiste en PostgreSQL.
- `notifications/appointment-events.ts`: eventos internos `appointment.created`, `.rescheduled`, `.cancelled`, `.confirmed`, `.completed`. Deciden los canales: correo (bandeja `Notification`) y WhatsApp (cola `AutomationJob`). Los OTP no pasan por aquí.
- `notifications/notification.service.ts`: bandeja durable con clave única por hecho y worker de reintentos.

## Verificación de cuentas

- Cuenta activa ⇔ `phone_verified_at IS NOT NULL`. El correo (`email_verified_at`) es opcional.
- Registro: nombre, correo, WhatsApp y contraseña → OTP `PHONE_VERIFICATION` → al verificar se crea la cuenta con `phoneVerifiedAt` y se abre sesión. Los datos pendientes viven en `PhoneChallenge` (contraseña ya con hash): un registro abandonado no bloquea el número.
- Teléfono normalizado en el backend a E.164 (`0981234519`, `593981234519` y `+593 98 123 4519` → `+593981234519`). `User.phone` es UNIQUE; una carrera entre dos registros termina con un único usuario y el mensaje «Ya existe una cuenta asociada a este número de WhatsApp», con accesos a iniciar sesión y recuperar contraseña.
- Login con credenciales correctas y WhatsApp sin verificar (cuentas anteriores): `403 PHONE_UNVERIFIED`, se envía un OTP y no se crea sesión ni otra cuenta. Las sesiones antiguas de esas cuentas dejan de valer hasta verificar. Los administradores no están sujetos a este requisito para no perder el acceso administrativo si WhatsApp no está disponible.
- Citas de invitado: solo después del OTP correcto se asocian las reservas con `userId = NULL`, el mismo teléfono normalizado, sin incidencia de identidad y creadas en los últimos 180 días (evita heredar reservas de un número reasignado). Cada vínculo queda en `IntegrationEvent` (`ACCOUNT_LINK`, `PHONE_OTP:<userId>`).

### OTP

| Regla          | Valor                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Generación     | `crypto.randomInt`, 6 dígitos                                                       |
| Almacenamiento | hash scrypt con sal; nunca en texto plano ni en logs                                |
| Caducidad      | 10 minutos                                                                          |
| Intentos       | 5 por código                                                                        |
| Reenvío        | cooldown 60 s; máximo 5 códigos por número y hora; el reenvío invalida el anterior  |
| Uso            | único; consumo transaccional con bloqueo por teléfono                               |
| Propósitos     | `PHONE_VERIFICATION`, `PASSWORD_RESET`, `PHONE_CHANGE`, sin intercambio entre ellos |
| Fallo de Bird  | la transacción se revierte: no queda código, no se verifica nada, error 503 visible |

Límites por IP (Nest Throttler): registro 5/min, login 10/min, verificar 10/min, reenviar 3/min, recuperar 5/min, completar recuperación 5/min, verificar correo 10/min, enviar verificación 3/min. A esto se suman los límites por número, correo y usuario guardados en PostgreSQL.

## Recuperación de contraseña

- **Recordando la contraseña actual**: Mi cuenta → Ajustes → Cambiar contraseña (pide la actual; cierra las demás sesiones).
- **Correo** (única recuperación): correo → enlace `#restablecer?token=…` (30 min) solo si `email_verified_at` no es nulo y el correo no cambió.
- **Nunca por WhatsApp**: no existe ruta de recuperación por WhatsApp (se retiró `auth/password-reset/whatsapp`). Sin correo verificado, el cliente contacta con Instafix.
- El token de recuperación (`AuthToken`, propósito `PASSWORD_RESET`) no es una sesión ni un JWT: un uso, caduca, pertenece al usuario. Completar la recuperación cierra todas las sesiones e invalida otros tokens.
- Respuesta sin enumeración: «Si existe una cuenta verificada asociada a estos datos, recibirás instrucciones para continuar.» Para correos no verificados o inexistentes la respuesta es la misma y no se envía nada.

## Mi cuenta → Seguridad

WhatsApp (enmascarado, verificado), correo (enmascarado, verificado/sin verificar, «Verificar correo»), contraseña («Cambiar contraseña»).

- Verificar correo: enlace `#verificar-correo?token=…` de 24 h y un uso; si el correo cambia antes de usarlo, el enlace ya no sirve.
- Cambiar correo: requiere contraseña y deja `email_verified_at = NULL`.
- Cambiar WhatsApp: requiere contraseña, comprueba UNIQUE, envía OTP `PHONE_CHANGE` al **nuevo** número y solo entonces cambia el número y `phone_verified_at`.

## Citas y correos de Instafix

| Evento       | Disparador                                                                | Correo                                                                                  | WhatsApp                                      |
| ------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| Creada       | API Instafix tras crear en Cal.com y guardar en PostgreSQL                | «Recibimos tu solicitud de visita» (pendiente de confirmación; nunca dice «confirmada») | `appointment_requested` (pide la ubicación)   |
| Confirmada   | Un técnico pulsa «Confirmar cita» en su panel (ver `docs/technicians.md`) | «Tu visita está confirmada ✓» con técnico, fecha, hora y solicitud                      | `appointment_confirmed` + recordatorios       |
| Reprogramada | API Instafix o webhook `BOOKING_RESCHEDULED` hecho en Cal.com             | Fecha anterior y nueva                                                                  | `appointment_rescheduled`                     |
| Cancelada    | API Instafix o webhook `BOOKING_CANCELLED`/`BOOKING_REJECTED`             | «Tu cita fue cancelada»                                                                 | `appointment_cancelled`                       |
| Recordatorio | 08:00 Ecuador                                                             | —                                                                                       | `appointment_reminder` (solo el día anterior) |

El correo muestra «Solicitud: “…”» con lo que describió el cliente; nunca un servicio realizado. Los invitados reciben «Tu cita ha sido creada correctamente» y una invitación a crear la cuenta con el mismo WhatsApp, sin botón que exija iniciar sesión.

**Sin duplicados**: cada correo tiene una clave única (`email:<cita>:APPOINTMENT_CREATED`, `…:APPOINTMENT_CANCELLED`, `…:APPOINTMENT_RESCHEDULED:<nuevo inicio>`). La API y el webhook usan el mismo bloqueo de PostgreSQL; si el webhook llega antes que la respuesta de Cal.com, la API completa la misma fila. Los webhooks de reservas creadas por Instafix (`source = INSTAFIX_API`) solo actualizan el estado de Cal.com. Si Cal.com falla, no se guarda la cita ni se envía nada; si falla PostgreSQL después de crear en Cal.com, se cancela esa reserva.

**Activación**: activados por defecto; solo `APPOINTMENT_EMAILS_ENABLED=false` los desactiva. A Cal.com no se le envía ningún correo de asistente: la reserva va solo con el teléfono (el tipo de evento no exige correo), así Cal.com no puede escribir al cliente y no hay duplicados. Solo si Cal.com rechazara una reserva por faltar el correo, se reintenta una vez con un buzón propio de Instafix (`CAL_ATTENDEE_RELAY_EMAIL` o el remitente de `SMTP_FROM`), nunca el del cliente. Los correos de relleno que Cal.com genere (p. ej. `…@sms.cal.com`) nunca se toman como correo del cliente. Cuando un aviso no se envía queda una fila `SKIPPED` con el motivo; si Brevo lo rechaza, el historial guarda la respuesta SMTP (p. ej. «550 … not verified») sin direcciones.

**Causa de «no llegan los correos de cita agendada o cancelada» (18-10-2026, 2.ª revisión)**: sin `CAL_ATTENDEE_RELAY_EMAIL` y con `APPOINTMENT_EMAILS_ENABLED` vacío, los avisos quedaban desactivados (`SKIPPED`): ningún correo salía de Instafix.

**Causa de «el correo de la cita no llega» (18-10-2026)**: con `APPOINTMENT_EMAILS_ENABLED=false` (el valor de los `.env.example`) `enqueueAppointmentEmail` devolvía `null` sin registrar nada: ni Brevo ni ningún log. Además, el correo de creación decía «Tu cita está confirmada» cuando la reserva no pedía ubicación. Ahora el motivo queda registrado y el correo de creación nunca anuncia una confirmación. «Aceptado por Brevo» en el historial no garantiza la bandeja de entrada: eso depende de SPF/DKIM/DMARC y se comprueba en el buzón y en los eventos de Brevo.

La ubicación por WhatsApp ya no confirma la visita: la confirma un técnico.

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

Usan PostgreSQL de desarrollo, Bird/Brevo/Cal.com simulados en memoria y datos temporales que se eliminan. `dependency-injection.test.ts` arranca el módulo Nest con `tsx` (como en producción) y falla si alguna dependencia queda sin inyectar.

Prueba manual local sin WhatsApp real: `NODE_ENV=development WHATSAPP_OTP_PROVIDER=console WHATSAPP_OTP_ENABLED=true` imprime el código en la consola de la API. Fuera de `NODE_ENV=development` ese proveedor está bloqueado.

Prueba real controlada de la plantilla OTP (un código aleatorio que no valida ninguna cuenta):

```sh
pnpm --filter @instafix/api whatsapp:test --to +5939XXXXXXXX --otp          # simulación
WHATSAPP_OTP_ENABLED=true pnpm --filter @instafix/api whatsapp:test --to +5939XXXXXXXX --otp --send
```

Correo real controlado: Administración → Comunicaciones → «Enviar prueba real». «Aceptado» significa que Brevo recibió el mensaje; la llegada a la bandeja se comprueba en el buzón y en los registros de Brevo.

**Reservas solo con teléfono (28-10-2026).** Causa del error «La agenda rechazó la reserva aunque el horario sigue libre»: el tipo de evento tenía un límite de reservas por persona y, como todas las reservas llevaban el mismo correo puente, Cal.com las contaba como de una sola persona. Se quitó el límite en Cal.com y la reserva ya no lleva correo de asistente.
