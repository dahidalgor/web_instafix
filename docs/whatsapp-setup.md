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
| Recordatorio el día anterior (08:00 Ecuador)                      | `appointment_reminder`           | Utility        |
| Código de verificación (registro, recuperación, cambio de número) | `bird_otp` (gestionada por Bird) | Authentication |

- **Idioma**: se usa el idioma aprobado de cada plantilla (`es-EC`, `es`…), leído de Bird. No se configura.
- **Variables con nombre**: Instafix ofrece `{{nombre}}` (primer nombre), `{{servicio}}` (lo que escribió el cliente), `{{fecha}}` («viernes 24 de octubre»), `{{hora}}` («10:00»), `{{tecnico}}` y `{{cuando}}` («mañana»/«hoy» en recordatorios, la fecha en el resto). Cada plantilla usa las que quiera; el proveedor envía solo las que declara su versión aprobada (caché de 10 minutos). Una plantilla con variables posicionales (`{{1}}`) o con nombres distintos **no se envía** y Administración → WhatsApp lo indica.
- **OTP**: `bird_otp` ya está aprobada por Meta y sale desde un número de Bird (no desde el de Instafix): «Tu código de verificación es _123456_. Por tu seguridad, no lo compartas.» + botón «Copiar código». Si Meta aprueba una plantilla propia, basta con cambiar `BIRD_OTP_TEMPLATE` en `whatsapp/bird/bird.provider.ts`.
- Se retiraron los avisos «técnico asignado» y «técnico en camino» (sin plantilla). Los trabajos antiguos de esos tipos se cancelan sin enviarse.

Editar el texto de una plantilla en Bird no requiere cambiar código mientras use esas variables.

## Webhook de Bird

1. **Bird → Developers → Webhooks → Crear**: URL `https://instafix.ec/api/v1/webhooks/bird` (el dominio de `PUBLIC_HOST`: Caddy sirve la API en `/api/*` de ese dominio; no existe un subdominio `api.`).
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
- Ubicación válida: la **ubicación nativa de WhatsApp**, un **enlace de Google Maps** (también `maps.app.goo.gl`, que se expande solo entre dominios de Google), Apple Maps o coordenadas escritas («-0.1807, -78.4678»). Un enlace sin coordenadas se guarda tal cual y el técnico ve «Abrir en Google Maps». Prueba un enlace con `whatsapp:diagnose --maps-link "<enlace>"`.
- **Calle y sector**: con las coordenadas se consulta OpenStreetMap Nominatim (gratuito, sin clave, máx. 1 petición/s; solo se envían las coordenadas) y se guarda en `Appointment.locationArea`, visible en el panel técnico y en Administración. Si falla, se reintenta cada 5 minutos durante 2 días. Se desactiva con `REVERSE_GEOCODING_ENABLED=false`.
- **Asociación ubicación ↔ cita** (`whatsapp/inbound.ts`). Cada mensaje se evalúa al llegar, sin depender del último ni del siguiente: un «ok», «gracias», emoji, imagen o sticker no cancela la espera ni borra la ubicación; solo otra ubicación válida la actualiza (la más reciente gana). Citas candidatas: mismo teléfono, activas (pendiente, confirmada o en servicio) y hasta 3 h después de su fin; nunca canceladas, completadas, pasadas ni eliminadas. Orden: (1) respuesta citando el aviso de una cita; (2) la única cita sin ubicación a la que ya se pidió por WhatsApp; (3) la única sin ubicación; (4) corrección de la que recibió una ubicación en las últimas 2 h, o la única activa. Con varias posibles: `AMBIGUOUS_LOCATION`, no se adivina; el equipo lo ve como incidencia y puede pegarla desde el panel técnico.
- Se guarda en la cita: `locationLatitude`, `locationLongitude`, `locationName` (nombre/dirección que envió WhatsApp), `locationReceivedAt`, `locationSource = WHATSAPP` y, después, `locationArea` (calle y sector). La dirección escrita (`address`) no se sobrescribe. Solo el webhook firmado puede poner `WHATSAPP`; lo que pega el técnico queda como `STAFF`. Coordenadas fuera de rango → `INVALID_LOCATION`, sin cambios.
- Privacidad: la ubicación exacta la ven el cliente dueño, el técnico asignado y administración; otros técnicos ven solo el sector de una cita pendiente. Las coordenadas no van a los registros.

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
   - **Aviso mínimo** (Limits → Minimum notice): pon un valor corto, por ejemplo **1 hora**. Instafix aplica su propia regla: se agenda **desde mañana** (fecha de Ecuador), incluido el primer horario de mañana aunque falten menos de 24 h (`BOOKING_MIN_DAYS_AHEAD`, por defecto 1). Con 24 h en Cal.com, esos horarios no aparecen.
3. Teléfono del asistente (`attendeePhoneNumber`) obligatorio, con código internacional.
4. Campo «¿Qué trabajo requiere?» (`notes`) obligatorio. La web de Instafix lo envía siempre.
5. Autorización de WhatsApp: la web de Instafix la manda en la metadata de la reserva (`instafixWhatsappConsent`), no como campo de Cal.com. **No** crees una casilla `whatsappConsent` obligatoria: la API no la envía y Cal.com rechazaría las reservas de la web. Si quieres que quien reserve directamente en la página pública de Cal.com también pueda autorizar, crea la casilla **opcional** con identificador exacto `whatsappConsent`.
   - Una reserva hecha en la página pública de Cal.com sin esa casilla aparece en Administración → WhatsApp → «Citas que necesitan atención» como «Falta autorización de WhatsApp en Cal.com». Confirma con el cliente que acepta WhatsApp y marca la casilla **«El cliente autorizó recibir mensajes de esta cita por WhatsApp»** (ahí mismo o al editar la cita y guardar): se registra la autorización, desaparece el aviso y sale el primer mensaje. La cita vuelve al flujo normal de una reserva de la web: queda en la cuenta del cliente si tiene una con ese teléfono verificado, los técnicos reciben el aviso «Nueva solicitud de cita» y el cliente el correo de cita recibida si tiene correo.
   - Para que nadie reserve por fuera de la web, oculta el evento en tu perfil de Cal.com y no compartas su enlace directo (Instagram, Google, WhatsApp Business): comparte la web de Instafix.
6. `CAL_API_KEY` de la cuenta propietaria, `CAL_EVENT_TYPE_ID` numérico, `CAL_API_VERSION=2026-02-25`.
7. Webhook JSON predeterminado con secreto `CAL_WEBHOOK_SECRET` y eventos `BOOKING_REQUESTED`, `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`.

## Operación

- Cola `AutomationJob` revisada cada 15 s; bandeja de webhooks cada 3 s. Sobreviven reinicios y se coordinan con PostgreSQL.
- Cancelar o reprogramar invalida los avisos pendientes de la revisión anterior.
- Hay un único recordatorio: el día anterior a las 08:00 de Ecuador (o al confirmar, si ya pasó esa hora). Caduca a las 00:00 del día de la visita: nunca sale un «mañana» el mismo día. Si la visita se confirma el mismo día, no hay recordatorio. El antiguo recordatorio del mismo día se retiró y los que quedaban encolados se cancelan sin enviarse.
- Mensajes solo con autorización del cliente (`whatsappConsentAt`).

## Pruebas

```sh
pnpm test
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 \
  src/tests/bird-provider.test.ts src/tests/bird-webhooks.integration.test.ts \
  src/tests/webhooks.integration.test.ts src/tests/whatsapp.integration.test.ts
```

Usan un doble del SDK de Bird y webhooks firmados como Bird; nunca llaman a Bird ni envían mensajes reales.
