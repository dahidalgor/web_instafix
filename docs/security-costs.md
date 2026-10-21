# Seguridad y control de costos

Objetivo: **una petición barata de un atacante no puede convertirse fácilmente en una operación
pagada por Instafix** (WhatsApp/Bird, correo/Brevo, Cal.com, geocodificación). Y, a la vez, las
reglas de costos **nunca dejan atrapado a un cliente en una cita**: la operación de negocio se
guarda primero; la notificación es un efecto secundario que puede omitirse.

```
Cloudflare (1.ª capa: DDoS, WAF, bots, rate limiting)
   → Caddy (IP real: CF-Connecting-IP solo desde rangos de Cloudflare → X-Real-IP)
      → NestJS (2.ª capa: límites por ruta e IP, por teléfono, cuenta, cita y sesión)
         → PostgreSQL (estado de la cita = crítico)
            → outbox AutomationJob → worker → presupuesto → Bird (secundario)
```

No existe protección absoluta contra DDoS: Cloudflare absorbe el volumen; la API limita el gasto.

## Límites por ruta (NestJS throttler, por IP real)

Definidos en `apps/api/src/security/rate-limits.ts`. Dos ventanas: por minuto y por hora.

| Política         | Rutas                                                   | min | hora |
| ---------------- | ------------------------------------------------------- | --- | ---- |
| `publicApi`      | resto de la API pública                                 | 120 | 3000 |
| `slots`          | `GET booking/slots` (con caché de 30 s)                 | 30  | 400  |
| `login`          | `POST auth/login`                                       | 10  | 40   |
| `register`       | `POST auth/register`                                    | 5   | 15   |
| `booking`        | `POST booking`                                          | 5   | 12   |
| `reschedule`     | `POST my/appointments/:id/reschedule`                   | 5   | 15   |
| `cancel`         | `POST my/appointments/:id/cancel`                       | 5   | 20   |
| `otp`            | reenvío de OTP, verificación y cambio de WhatsApp       | 3   | 10   |
| `otpVerify`      | comprobar códigos y enlaces                             | 10  | 40   |
| `recovery`       | recuperación de contraseña, cambio de correo/contraseña | 5   | 15   |
| `communications` | verificación de correo, correos de prueba               | 3   | 10   |
| `staff`          | acciones del equipo                                     | 60  | 1500 |

Respuesta: `429 Too Many Requests` (se registra `security.rate_limited`). Los webhooks firmados
(Bird, Cal.com) no se limitan por IP para no perder reintentos legítimos.

### IP real y proxies de confianza

- Caddy acepta `CF-Connecting-IP` **solo** si la conexión llega desde un rango de Cloudflare
  (`trusted_proxies` en `deploy/Caddyfile`) y envía a la API `X-Real-IP {client_ip}`,
  sobrescribiendo cualquier valor del cliente.
- La API (en producción) usa solo `X-Real-IP`; nunca `X-Forwarded-For`. En desarrollo, la IP de
  la conexión. Las IP se guardan como HMAC (`IP_HASH_SECRET`), nunca en claro.
- Revisar de vez en cuando los rangos en https://www.cloudflare.com/ips/.

## Límites de negocio (backend)

- **Reservas**: máx. 3 por teléfono y 6 por IP en 24 h; máx. 3 citas activas por teléfono.
  Doble clic / recarga: `Idempotency-Key` y, sin ella, la misma reserva reciente (mismo
  teléfono y horario, 15 min) se devuelve sin crear otra en Cal.com.
- **Reprogramaciones**: máximo **2 por cita** (`Appointment.rescheduleCount`). El contador se
  incrementa en la misma actualización condicionada que cambia el horario
  (`rescheduleCount < 2`), dentro de un bloqueo por cita: sin carreras. El tercer intento se
  rechaza (`RESCHEDULE_LIMIT`) **antes** de llamar a Cal.com o a Bird. Cambios de notas,
  técnico o datos internos no cuentan; un cambio real de fecha/hora desde Administración o
  Cal.com sí cuenta, pero el equipo no queda bloqueado.
- **Login**: máx. 8 fallos por número y 30 por IP en 15 min (`LOGIN_LOCKED`), igual exista o no
  la cuenta (sin enumeración).
- **Recuperación**: respuesta genérica siempre («Si existe una cuenta…»).
- **Números bloqueados** (Administración → Números): no pueden agendar, registrarse, pedir OTP
  ni recibir avisos; la recuperación responde igual que siempre sin enviar nada. El motivo es
  interno.

## WhatsApp (Bird) — presupuesto

No hay ningún endpoint del tipo `POST /send-whatsapp`: el navegador pide acciones de negocio y el
backend decide si corresponde un aviso. Bird solo se llama desde el worker y el OTP.

Orden de una operación (p. ej. cancelar):

```
validar → actualizar la cita (CANCELLED) → commit → encolar aviso (AutomationJob)
   → worker: ¿hay presupuesto? → sí: Bird → SENT  ·  no: SUPPRESSED_BUDGET (sin llamar a Bird)
```

La cita queda cancelada en ambos casos; la API no informa error por falta de presupuesto.

Topes (`apps/api/src/whatsapp/budget.ts`), contando mensajes `SENT`, `SENDING` o `REVIEW`:

| Ámbito                           | Tope                                           | Estado al superarlo     |
| -------------------------------- | ---------------------------------------------- | ----------------------- |
| Sesión del cliente (30 días)     | **10**                                         | `SUPPRESSED_BUDGET`     |
| Cita (toda su vida)              | 10                                             | `SUPPRESSED_BUDGET`     |
| Tipo de aviso por cita           | p. ej. CANCELLED 1, CONFIRMED 3, RESCHEDULED 2 | `SUPPRESSED_BUDGET`     |
| Cuenta de cliente (30 días)      | 20                                             | `SUPPRESSED_BUDGET`     |
| Teléfono de destino (24 h)       | 10                                             | `SUPPRESSED_RATE_LIMIT` |
| IP de origen (24 h)              | 20                                             | `SUPPRESSED_RATE_LIMIT` |
| Número bloqueado                 | —                                              | `SUPPRESSED_BLOCKED`    |
| `WHATSAPP_SENDING_ENABLED=false` | —                                              | `SUPPRESSED_DISABLED`   |

La sesión es la cookie de sesión o, para invitados, una cookie aleatoria propia
(`instafix_client`). Borrar cookies crea otra sesión; por eso también hay topes por teléfono,
cuenta, cita e IP. Sin fingerprinting.

- Un aviso `SUPPRESSED_*` **nunca** se reintenta (el worker solo toma `PENDING`/`RETRY`, y
  Administración solo reintenta fallos confirmados).
- Deduplicación: `dedupeKey = cita:revisión:tipo`; un reintento técnico no reenvía un mensaje ya
  aceptado; un resultado incierto queda en `REVIEW` (cuenta como gastado, no se reenvía a ciegas).
- Solo las transiciones reales generan avisos: `CONFIRMED → CONFIRMED` o
  `CANCELLED → CANCELLED` no publican nada.
- Recibir mensajes o ubicaciones del cliente **no** genera mensajes salientes.
- Auditoría: cada `AutomationJob` guarda cita, tipo/evento (`APPOINTMENT_CREATED`,
  `…_CONFIRMED`, `…_RESCHEDULED`, `…_CANCELLED`, recordatorios), canal, proveedor, estado,
  fechas e id de Bird, y el motivo de la supresión. Sin contenido del mensaje.

### OTP (presupuesto propio)

Cooldown 60 s; 5 por hora y 8 por día por número; 8 por hora y 20 por día por IP; 5 por hora
por sesión; máximo 3 reenvíos por solicitud; caducidad 10 min; 5 intentos. El código solo se
guarda con hash y nunca se registra.

## Correo (Brevo), calendario (Cal.com) y otras APIs

- Correos de citas: bandeja `Notification` con clave única por hecho (sin duplicados entre la
  API y los webhooks). Verificación/recuperación: máximos por hora en `AuthToken`.
- Cal.com: se llama una sola vez por acción (`Idempotency-Key` + bloqueo por cita); reintentos
  y operaciones simultáneas reciben el resultado guardado o `409 REQUEST_IN_PROGRESS`.
- Nominatim (geocodificación): 1 petición/s, solo con coordenadas, desactivable.
- Un fallo de notificación nunca revierte una operación ya confirmada en la base de datos.

## Registro de seguridad

Eventos: `security.rate_limited` (429), `booking.duplicate_ignored`, `booking.reschedule_limit`,
`whatsapp.suppressed`, `security.otp_excessive`, `security.blocked_phone`,
`auth.login_failed` (con contador), `admin.action` (+ tabla `AdminAction`). Nunca contraseñas,
OTP, claves, tokens, cookies ni secretos.

## Cloudflare — configuración manual recomendada

Sin cambios destructivos de DNS: solo activar el proxy (nube naranja) en los registros que ya
apuntan al servidor, si aún no lo está.

1. **SSL/TLS** → modo _Full (strict)_. **Always Use HTTPS** activado.
2. **Security → Bots** → _Bot Fight Mode_ activado (o _Super Bot Fight Mode_: “Definitely
   automated” = Block, “Likely automated” = Managed Challenge, excepto en `/api/v1/webhooks/*`).
3. **Security → WAF → Managed rules**: activar _Cloudflare Managed Ruleset_ (plan Pro o
   superior; en Free, las reglas gratuitas disponibles).
4. **Security → WAF → Rate limiting rules** (primera capa, antes de la API):
   - `URI Path` empieza por `/api/v1/auth/` → 20 peticiones / 1 min por IP → _Block_ 10 min.
   - `URI Path` es `/api/v1/booking` y método `POST` → 10 / 1 min por IP → _Managed Challenge_.
   - `URI Path` contiene `/reschedule` o `/cancel` → 10 / 1 min por IP → _Block_.
   - `URI Path` empieza por `/api/v1/` → 300 / 1 min por IP → _Block_ 1 min.
5. **Security → WAF → Custom rules**:
   - Permitir sin desafío `/api/v1/webhooks/bird` y `/api/v1/webhooks/cal` (las firmas se
     verifican en la API; un desafío rompería los reintentos de Bird/Cal.com).
   - _Managed Challenge_ a `/api/v1/` cuando `cf.threat_score > 30`.
   - Opcional: países permitidos para `/api/v1/auth/` y `POST /api/v1/booking` si el negocio solo
     atiende Ecuador (no aplicar a los webhooks).
6. **DDoS**: la protección HTTP DDoS está activa por defecto; dejar la sensibilidad en _High_.
7. **Origen**: en el firewall del servidor, permitir 80/443 solo desde los rangos de Cloudflare,
   para que nadie llegue a Caddy sin pasar por Cloudflare.
8. **Caché**: no cachear `/api/*` (la API ya responde `Cache-Control: no-store` donde importa).
