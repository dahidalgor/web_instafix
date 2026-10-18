# Diagnóstico de errores frecuentes · 18 de octubre de 2026

## «Las HH:MM acaban de dejar de estar disponibles» con cualquier horario

**Causa**: el backend convertía cualquier rechazo 4xx de Cal.com en «horario ocupado» (409). Una clave de API inválida (401), permisos (403), un tipo de evento incorrecto (404) o un campo obligatorio de la reserva (400) aparecían como si el horario se hubiera ocupado. `GET /v2/slots` es público en Cal.com, así que los horarios se veían aunque crear la reserva fallara.

**Ahora**:

1. Antes de crear, se revalida contra la disponibilidad actual de Cal.com del día de Ecuador (sin caché) comparando **instantes** (`16:45-05:00` = `21:45Z`).
2. Si el horario ya no se ofrece → `409 SLOT_UNAVAILABLE`: la web vuelve al calendario, deselecciona y recarga horarios.
3. Si Cal.com rechaza: 401/403 → `503 BOOKING_CONFIG`; otro 4xx → se vuelve a consultar la disponibilidad: si el horario desapareció → `409 SLOT_UNAVAILABLE`; si sigue libre → `502 BOOKING_REJECTED` con el motivo en los registros.

Registros (una línea JSON, sin datos del cliente ni claves): `booking.revalidated`, `booking.cal_rejected` (estado HTTP y motivo de Cal.com), `booking.recheck_after_reject`, `booking.cal_created`.

```sh
docker compose --env-file .env.production -f compose.production.yaml logs api | grep '"event":"booking'
```

Si aparece `booking.cal_rejected` con `calStatus` 401/403: revisa `CAL_API_KEY` (válida, del mismo usuario/equipo dueño del tipo de evento). Con 400: el motivo indica el campo del tipo de evento que no coincide (`servicio`, `whatsappConsent`, `attendeePhoneNumber`).

## No se puede iniciar sesión en local («Tu acceso está desactivado» / «No pudimos conectar con tu cuenta»)

**Causa**: tras actualizar el código, el cliente Prisma seguía generado con el esquema anterior (sin la columna `User.active`). El login leía `active` como ausente y lo trataba como cuenta desactivada; `/auth/me` fallaba con 500.

**Ahora**: `pnpm dev` genera el cliente Prisma antes de arrancar la API; la API comprueba al iniciar que el cliente y las migraciones están al día y registra `db.schema_mismatch` con el comando exacto; solo `active = false` desactiva una cuenta. Errores en la web según la causa: `INVALID_CREDENTIALS` (401), `ACCOUNT_DISABLED` (403), `RATE_LIMITED` (429), `API_UNREACHABLE`/`SERVER_ERROR` (5xx), `NETWORK_ERROR` (sin conexión).

Tras `git pull` con cambios de base de datos:

```sh
pnpm --filter @instafix/api exec prisma migrate deploy --schema ../../database/schema.prisma
pnpm dev
```

## «Conectar WhatsApp» abre una ventana en blanco que se cierra

**Causa en el código**: el popup se abría en blanco y, si `POST /admin/whatsapp/connect/session` fallaba, se cerraba con `popup.close()`; el motivo quedaba solo en el panel.

**Ahora**: la ventana abre `/whatsapp-connect.html` («Preparando la conexión…»). Si la sesión falla, la ventana se queda abierta con «No pudimos conectar WhatsApp», el motivo, **Reintentar** y **Cerrar**. Si WasapFlow cancela, da error o se cierra sin resultado, el panel lo explica y el servidor registra `whatsapp.connect_*` (inicio, fallo, resultado).

Diagnóstico en producción (no envía mensajes; crea una sesión de prueba que caduca sola):

```sh
docker compose --env-file .env.production -f compose.production.yaml run --rm api \
  pnpm --filter @instafix/api whatsapp:diagnose
docker compose --env-file .env.production -f compose.production.yaml logs api | grep '"event":"whatsapp.connect'
```
