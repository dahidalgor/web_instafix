# Diagnóstico de errores frecuentes · 18 de octubre de 2026

## La web muestra todos los meses sin horarios

La web no inventa horarios: muestra los que devuelve Cal.com (`GET /v2/slots` con `CAL_EVENT_TYPE_ID`). Si Cal.com falla, la web muestra un error; un calendario vacío significa que Cal.com respondió «sin horarios».

**Revisión** (no muestra datos de clientes ni claves):

- Administración → WhatsApp → **Agenda (Cal.com)**: horarios de los próximos 30 días y campos del evento que romperían las reservas.
- Terminal:

  ```sh
  docker compose --env-file .env.production -f compose.production.yaml exec api pnpm cal:check
  ```

- Registro: `booking.slots_empty` cuando un mes entero llega vacío.

**Caso del 30-10-2026**: el evento tenía activados «Limit booking frequency» y «Limit total booking duration» (Limits). Al alcanzar el tope, Cal.com dejó de ofrecer horarios en toda la agenda, también en su propia página. La revisión de la agenda ahora los señala.

**Causas habituales en Cal.com**: el evento no tiene una disponibilidad (horario) con horas, el rango de fechas reservables terminó, se cambió el evento o su ID (`CAL_EVENT_TYPE_ID`), un límite de reservas o un aviso mínimo muy alto. Ocultar el evento («Hidden») solo lo quita del perfil público: en el código de Cal.com no afecta a los horarios de la API. Si al ocultarlo desaparecieron, vuelve a mostrarlo y revisa qué más cambió en el evento.

**Campos del evento**: la web envía `name`, `attendeePhoneNumber` y `notes`, y la autorización de WhatsApp en la metadata. Cualquier otro campo **obligatorio** (por ejemplo una casilla `whatsappConsent` obligatoria) hace que Cal.com rechace todas las reservas de la web; la revisión de la agenda lo avisa.

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

## WhatsApp no envía o no se ve entregado

Ya no hay botón «Conectar WhatsApp»: el número se conecta en Bird (Numbers → WhatsApp, Coexistence). En Administración → WhatsApp revisa número (conectado, Coexistence), plantillas y el estado de cada envío. «Aceptado por Bird» no es «Entregado»: la entrega llega por el webhook `api/v1/webhooks/bird`.

```sh
docker compose --env-file .env.production -f compose.production.yaml run --rm api \
  pnpm --filter @instafix/api whatsapp:diagnose
docker compose --env-file .env.production -f compose.production.yaml logs api | grep '"event":"whatsapp.'
```

- `AUTH` / `PERMISSION`: revisa `BIRD_API_KEY` y sus permisos en Bird.
- `TEMPLATE`: la plantilla usa variables distintas de `{{nombre}}`, `{{servicio}}`, `{{fecha}}`, `{{hora}}`, `{{tecnico}}`, `{{cuando}}`.
- Entrega `FAILED` con Meta 100: suele ser un envío del número de Instafix a sí mismo o un parámetro inválido.
- Nada entregado nunca: falta registrar el webhook o `BIRD_WEBHOOK_SECRET` no coincide (la API responde 403 y registra `whatsapp.webhook_rejected`).

Detalles en [whatsapp-setup.md](whatsapp-setup.md).
