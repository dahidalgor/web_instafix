# WhatsApp de Instafix · Bird + Coexistence

Arquitectura única:

```text
Citas / OTP ─► WhatsAppService · WhatsAppCodeSender      (Instafix: qué aviso y qué datos)
                  └─► WhatsAppProvider                   (contrato neutral: whatsapp/provider.ts)
                         └─► BirdWhatsAppProvider        (plantillas, errores, webhooks)
                                └─► BirdClient           (@messagebird/sdk, único import del SDK)
```

El número **+593984703819** sigue en WhatsApp Business App mediante **Coexistence**. Se conectó una sola vez desde el panel de Bird; Instafix no tiene botón de conexión ni popup.

## Variables del backend

En `.env` (desarrollo) o `.env.production` (servidor). Nunca en Vite, en Git, en logs ni en tests:

```dotenv
BIRD_API_KEY=                 # Bird → Settings → API keys (bk_<región>_…)
BIRD_WEBHOOK_SECRET=          # secreto de firma del webhook (whsec_…), se ve una sola vez al crearlo
WHATSAPP_BUSINESS_PHONE=+593984703819   # número emisor conectado en Bird
WHATSAPP_ENABLED=false        # avisos de citas
WHATSAPP_OTP_ENABLED=false    # códigos de verificación
```

`WHATSAPP_ENABLED` y `WHATSAPP_OTP_ENABLED` son independientes. Las antiguas `WASAPFLOW_*` y `WHATSAPP_TEMPLATE_*` ya no se leen: las plantillas se definen en el código y se resuelven en Bird.

Permisos de la API key: lectura y envío de WhatsApp, números y plantillas. `workspace:read` es opcional (solo el diagnóstico muestra el nombre del workspace).

## Plantillas

| Aviso de Instafix                                                 | Plantilla en Bird                | Categoría      |
| ----------------------------------------------------------------- | -------------------------------- | -------------- |
| Solicitud recibida (pide ubicación)                               | `appointment_requested`          | Utility        |
| Técnico confirma la visita                                        | `appointment_confirmed`          | Utility        |
| Reprogramada                                                      | `appointment_rescheduled`        | Utility        |
| Cancelada                                                         | `appointment_cancelled`          | Utility        |
| Recordatorio día anterior y mismo día (08:00 Ecuador)             | `appointment_reminder`           | Utility        |
| Código de verificación (registro, recuperación, cambio de número) | `bird_otp` (gestionada por Bird) | Authentication |

- **Idioma**: se usa el idioma aprobado de cada plantilla (`es-EC`, `es`…), leído de Bird. No se configura.
- **Variables con nombre**: Instafix ofrece `{{nombre}}` (primer nombre), `{{servicio}}` (lo que escribió el cliente), `{{fecha}}` («viernes 24 de octubre»), `{{hora}}` («10:00»), `{{tecnico}}` y `{{cuando}}` («mañana»/«hoy» en recordatorios, la fecha en el resto). Cada plantilla usa las que quiera; el proveedor envía solo las que declara su versión aprobada (caché de 10 minutos). Una plantilla con variables posicionales (`{{1}}`) o con nombres distintos **no se envía** y Administración → WhatsApp lo indica.
- **OTP**: `bird_otp` ya está aprobada por Meta y sale desde un número de Bird (no desde el de Instafix): «Tu código de verificación es _123456_. Por tu seguridad, no lo compartas.» + botón «Copiar código». Si Meta aprueba una plantilla propia, basta con cambiar `BIRD_OTP_TEMPLATE` en `whatsapp/bird/bird.provider.ts`.
- Se retiraron los avisos «técnico asignado» y «técnico en camino» (sin plantilla). Los trabajos antiguos de esos tipos se cancelan sin enviarse.

Editar el texto de una plantilla en Bird no requiere cambiar código mientras use esas variables.

## Webhook de Bird

1. **Bird → Developers → Webhooks → Crear**: URL `https://api.instafix.ec/api/v1/webhooks/bird` (o la URL pública de la API).
2. Eventos: `whatsapp.sent`, `whatsapp.delivered`, `whatsapp.read`, `whatsapp.failed`, `whatsapp.rejected`, `whatsapp.received` (opcional `whatsapp.accepted`, se ignora).
3. Copia el secreto (`whsec_…`) que aparece **una sola vez** y guárdalo como `BIRD_WEBHOOK_SECRET` en el servidor; reinicia la API.
4. Usa «Enviar prueba» de Bird: debe responder 200. Con firma incorrecta la API responde 403; sin secreto configurado, 503.

Funcionamiento:

- Firma **Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`) verificada con el SDK sobre el cuerpo crudo; marcas de tiempo antiguas se rechazan.
- Idempotencia: la fila de la bandeja `WhatsAppWebhook` usa `BIRD:<webhook-id>`; los reintentos de Bird no se procesan dos veces. Los estados y mensajes entrantes también se deduplican por id de mensaje.
- Se guarda solo el evento normalizado; al procesarlo se vacía el contenido de la bandeja.
- Estados normalizados en `AutomationJob.deliveryStatus`: `SENT`, `DELIVERED`, `READ`, `FAILED` (failed y rejected), monótonos aunque lleguen desordenados o antes de guardar el envío. «Aceptado por Bird» (`status = SENT` del trabajo) **no es entregado**.
- Mensajes entrantes (`whatsapp.received`): texto, remitente, id, fecha, ubicación, media (tipo, MIME, pie; no se descarga) y respuesta citada. Fuente:
  - `customer_live`: el cliente escribió ahora. Solo esta fuente puede aportar la ubicación de una cita.
  - `business_app`: eco de lo que escribes desde el teléfono (Coexistence).
  - `history`: historial sincronizado. Nunca dispara automatizaciones.
- La ubicación se asigna a la cita respondida (`in_reply_to_message_id` = id del aviso) o a la única cita pendiente de ese teléfono; con varias, se marca para revisión.

## Errores normalizados

`CONFIG`, `AUTH` (clave inválida), `PERMISSION`, `CHANNEL`, `RECIPIENT`, `TEMPLATE`, `TEMPLATE_NOT_APPROVED`, `BILLING`, `RATE_LIMIT`, `META_REJECTED` (llega como entrega `FAILED` con código Meta), `PROVIDER_UNAVAILABLE`, `NETWORK`, `UNKNOWN`.

- Límite de envíos, Bird no disponible (503) o sin conexión → se reintenta solo.
- Tiempo agotado o error interno de Bird → **revisión**: Bird pudo haberlo enviado; compruébalo en Bird → WhatsApp → Mensajes antes de reintentar.
- Resto → fallo definitivo hasta corregir la causa; «Reintentar envío fallido» en Administración.

Logs (`whatsapp.accepted`, `whatsapp.send_failed`, `whatsapp.webhook_*`): proveedor, operación, id de cita, id del mensaje, estado y código normalizado. Nunca la clave, el código OTP, el teléfono completo ni respuestas crudas.

## Diagnóstico

```sh
pnpm --filter @instafix/api whatsapp:diagnose          # solo lectura
pnpm --filter @instafix/api whatsapp:diagnose --to +5939XXXXXXXX --template appointment_confirmed \
  --param "fecha=viernes 24 de octubre" --param hora=10:00 --param tecnico=David --send
pnpm --filter @instafix/api whatsapp:diagnose --message wam_…   # estado y línea de tiempo
```

Muestra clave (solo región), WABA, números (estado, Coexistence, calidad, límite), plantillas con su idioma, texto y variables, y la línea de tiempo accepted → sent → delivered → read. No envíes al propio número de Instafix: WhatsApp no entrega mensajes de un número a sí mismo.

## Cal.com

En el evento `instafix/agenda-tu-cita-con-instafix`:

1. Activa **requiere confirmación**: la reserva queda pendiente hasta que un técnico la confirma en Instafix ([Técnicos](technicians.md)).
2. Zona operativa `America/Guayaquil`.
3. Teléfono del asistente (`attendeePhoneNumber`) obligatorio, con código internacional.
4. Campo de texto obligatorio con identificador **`servicio`**.
5. Casilla obligatoria **`whatsappConsent`**: «Autorizo a InstaFix a enviarme por WhatsApp la confirmación y los recordatorios de esta cita».
6. `CAL_API_KEY` de la cuenta propietaria, `CAL_EVENT_TYPE_ID` numérico, `CAL_API_VERSION=2026-02-25`.
7. Webhook JSON predeterminado con secreto `CAL_WEBHOOK_SECRET` y eventos `BOOKING_REQUESTED`, `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`.

## Operación

- Cola `AutomationJob` revisada cada 15 s; bandeja de webhooks cada 3 s. Sobreviven reinicios y se coordinan con PostgreSQL.
- Cancelar o reprogramar invalida los avisos pendientes de la revisión anterior.
- Los recordatorios solo se envían mientras son pertinentes (no «mañana» el mismo día, nada después del inicio).
- Mensajes solo con autorización del cliente (`whatsappConsentAt`).

## Pruebas

```sh
pnpm test
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 \
  src/tests/bird-provider.test.ts src/tests/bird-webhooks.integration.test.ts \
  src/tests/webhooks.integration.test.ts src/tests/whatsapp.integration.test.ts
```

Usan un doble del SDK de Bird y webhooks firmados como Bird; nunca llaman a Bird ni envían mensajes reales.
