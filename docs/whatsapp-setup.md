# WhatsApp de InstaFix · WasapFlow Bridge + Coexistence

Arquitectura única: **negocio/cola → WhatsAppService → WasapFlowClient → WasapFlow Bridge → WhatsApp**. El número **+593984703819** continúa en WhatsApp Business App mediante Coexistence. No hay transporte directo a Meta, registro manual de WABA ni SDK de Facebook en React.

Contratos verificados contra [WasapFlow Bridge API v2.9.2](https://partner.wasapflow.com/bridge/docs), actualizada el 1 de septiembre de 2026. No se llamó a endpoints reales de envío o registro durante las pruebas.

## Configuración del backend

En `.env` (desarrollo) o `.env.production` (servidor), nunca en Vite:

```dotenv
WASAPFLOW_BASE_URL=https://officialapi.wasapflow.com/bridge/v1
WASAPFLOW_PARTNER_KEY=
WASAPFLOW_WABA_ID=
WASAPFLOW_WEBHOOK_SECRET=
WHATSAPP_ENABLED=false
WHATSAPP_BUSINESS_PHONE=+593984703819
WHATSAPP_TEMPLATE_LANGUAGE=es
WHATSAPP_TEMPLATE_INITIAL=instafix_solicitar_ubicacion
WHATSAPP_TEMPLATE_CONFIRMED=instafix_cita_confirmada
WHATSAPP_TEMPLATE_DAY_BEFORE=instafix_recordatorio_manana
WHATSAPP_TEMPLATE_SAME_DAY=instafix_recordatorio_hoy
```

La Partner Key viene del panel de WasapFlow y se transmite exclusivamente en `x-partner-key`. Obtén el Webhook Secret en **Settings → Webhook Security**. La URL está restringida al origen HTTPS oficial y no se siguen redirecciones. No se imprimen claves, respuestas completas del proveedor ni tokens temporales.

`WASAPFLOW_WABA_ID` es opcional: limita qué WABA puede conectarse. La WABA operativa se persiste en `WhatsAppConnection` al completar el onboarding. Poner un ID en el entorno **no activa** una conexión sin verificar. No necesitas tokens, App Secret ni Phone Number ID de Meta en Instafix.

## Conectar el número sin quitarlo de la aplicación

1. Configura Partner Key y Webhook Secret en el servidor; deja `WHATSAPP_ENABLED=false`.
2. En WasapFlow configura **Settings → Webhook URL** con `https://instafix.ec/api/v1/webhooks/wasapflow`. La web/API necesitan estar publicadas con HTTPS. No existe el desafío GET de Meta: este endpoint recibe POST de WasapFlow firmados con `x-wasapflow-signature: sha256=…`.
3. En **Administración → WhatsApp**, pulsa **Conectar WhatsApp Business**. El backend comprueba que `/embedded-signup/config` anuncie `connection_mode: coexistence` y llama a `POST /connect/session` con `display_name: Instafix` y un `state` aleatorio por intento. Abre el `connect_url` temporal devuelto; nunca se incluye la Partner Key en una URL.
4. Completa el onboarding alojado por WasapFlow y elige conectar el número que ya usa WhatsApp Business App. No borres la cuenta ni desconectes la aplicación. Si el proveedor no ofrece Coexistence, detén ese alta y consulta con WasapFlow.
5. El popup debe devolver `WASAPFLOW_CONNECT_SUCCESS` y `connection_mode: coexistence`. El navegador valida origen, ventana y `state`; el backend valida la sesión administrativa, caducidad y uso único, y consulta `/clients` para comprobar que la WABA esté activa y pertenezca al partner. Si la respuesta incluye un modo distinto, se rechaza. El contrato publicado de `/clients` puede omitir el modo: por eso también se exige el modo de la configuración previa y del callback del onboarding alojado. No se sustituye una WABA operativa por otra desde este flujo.
6. El panel mostrará **Conectado con Coexistence**. Confirma que sigues enviando manualmente desde tu teléfono y que aparece la actividad como **WhatsApp Business App**. Verifica la sincronización inicial el mismo día; el proveedor documenta límites temporales para iniciarla. Instafix no ejecuta operaciones de desconexión ni re-registro para forzarla.

El enlace dura 30 minutos; WasapFlow admite finalizar un flujo abierto a tiempo durante otros 30 minutos. Cerrar/cancelar la ventana permite repetir con un nuevo estado. Solo se guarda el hash del estado, vinculado al administrador; no el token del enlace.

## Textos y plantillas conservados

Los cuatro cuerpos de [whatsapp-templates.json](whatsapp-templates.json) se mantienen sin cambios:

| Momento                                    | Plantilla                      | Parámetros                   |
| ------------------------------------------ | ------------------------------ | ---------------------------- |
| Reserva pendiente                          | `instafix_solicitar_ubicacion` | Nombre, trabajo, fecha, hora |
| Ubicación recibida y confirmación correcta | `instafix_cita_confirmada`     | Nombre                       |
| Día anterior, 08:00 Ecuador                | `instafix_recordatorio_manana` | Trabajo, hora                |
| Mismo día, 08:00 Ecuador                   | `instafix_recordatorio_hoy`    | Nombre                       |

Crea o revisa estas plantillas mediante WasapFlow, idioma `es`, con los cuerpos y ejemplos del archivo. La aprobación de Meta sigue siendo necesaria. El archivo es una especificación de contenidos, **no** un body para enviar directamente a Bridge: el adaptador construye `POST /messages/template` con `template.language` como cadena.

Los avisos automáticos usan templates incluso si hay una ventana abierta. `WhatsAppService.replyText` utiliza `POST /messages/send` solo si existe un mensaje entrante nuevo del cliente dentro de las últimas 24 horas; no se cuentan ecos, historial ni recibos. BSUID se guarda separado del teléfono y nunca se transforma en un número. Una ubicación sin teléfono no se asigna automáticamente a una cita.

La hora estimada de llegada y la explicación de trabajos anteriores/traslados conservan su redacción. No había disparadores implementados de «técnico asignado», «técnico en camino» o «cancelación notificada»: el mensaje del mismo día anuncia comunicación humana del técnico. La cancelación existente **detiene recordatorios**, sin inventar nuevos avisos. Los tipos y parámetros se centralizan en `messages.ts`, para ampliar el mapeo a templates cuando se defina ese flujo.

## Cal.com: conservar el flujo de citas

En el evento `instafix/agenda-tu-cita-con-instafix`:

1. Activa **requiere confirmación**. La reserva debe permanecer pendiente hasta recibir la ubicación; no la confirmes manualmente si quieres mantener este flujo.
2. Establece `America/Guayaquil` como zona operativa. El ejemplo de agenda contempla una visita individual por reserva.
3. Haz obligatorio el teléfono del asistente (`attendeePhoneNumber`), con código internacional.
4. Añade un campo de texto obligatorio cuyo identificador sea **`servicio`**, con el equipo y trabajo solicitado. No es suficiente cambiar solamente la etiqueta visible.
5. Añade una casilla obligatoria cuyo identificador sea **`whatsappConsent`**: «Autorizo a InstaFix a enviarme por WhatsApp la confirmación y los recordatorios de esta cita». El webhook debe entregar su valor booleano `true`.
6. Crea una clave de API de la cuenta propietaria del evento y guárdala en `CAL_API_KEY`. Configura `CAL_EVENT_TYPE_ID` con el identificador numérico del evento. La versión de los endpoints de consulta/confirmación revisada es `CAL_API_VERSION=2026-02-25`.
7. Crea el webhook con cuerpo JSON predeterminado, sin plantilla personalizada, y un secreto aleatorio compartido con `CAL_WEBHOOK_SECRET`. Selecciona `BOOKING_REQUESTED`, `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED` y `BOOKING_REJECTED`.

El calendario incrustado continúa usando tus horarios. La selección del catálogo no modifica automáticamente el precio en Cal.com: el campo `servicio` aporta la descripción del mensaje. Los webhooks incompletos se guardan como citas que requieren atención y no generan envíos.

## Recepción, persistencia y operación

- El webhook verifica HMAC sobre los bytes originales y guarda solo campos permitidos en `BridgeWebhook` antes de responder. No ejecuta llamadas externas al recibirlo. Si falla la persistencia devuelve error para que el proveedor reintente.
- Un worker revisa la bandeja cada 3 segundos. La cola de recordatorios conserva su intervalo de 15 segundos. Ambos sobreviven reinicios y coordinan ejecuciones con PostgreSQL.
- `message.received`: guarda el mensaje nuevo; una ubicación del mismo teléfono activa el flujo existente. Primero confirma Cal.com; solo tras éxito marca la cita confirmada y encola su mensaje.
- `message.sent/delivered/read/failed`: correlaciona `message_id`/wamid y conserva estados monotónicos, aunque lleguen antes de persistir la respuesta del envío.
- `message.echo`: almacena salida manual, origen `business_app`. Nunca llama al transporte ni confirma citas.
- `message.history`: almacena fecha original y dirección. Nunca abre ventanas de conversación, dispara respuestas ni sustituye un mensaje nuevo ya guardado.
- `contact.synced`: sincroniza contactos propios de WhatsApp, incluida baja lógica. No elimina usuarios ni clientes de Instafix.
- Se guardan teléfono y BSUID por separado, contenido permitido e identificador del mensaje. Los tipos no textuales aparecen como tales en el panel; esta entrega no descarga medios históricos ni incorpora un chat completo con adjuntos.
- Durante un onboarding pendiente pueden recibirse eventos antes del callback; se almacenan en espera, pero solo se procesan para la WABA finalmente verificada. Otras WABAs no disparan lógica de negocio. Los eventos procesados conservan su huella y eliminan el payload temporal. Los errores repetidos aparecen como revisión en administración.
- Las citas canceladas/reprogramadas invalidan sus mensajes pendientes. Los resultados de envío inciertos se revisan en WasapFlow antes de repetirlos; no se reenvían automáticamente a ciegas.
- Si hay varias citas pendientes de un teléfono, pide compartir la ubicación respondiendo al mensaje de la cita correcta. No se elige una al azar.
- Los recordatorios se recuperan tras reinicio solo mientras sean pertinentes: no se envía «mañana» el mismo día ni recordatorios después del inicio. Una cita a las 08:00 o antes no recibe el aviso de ese mismo día.
- No se ha añadido validación geográfica, asignación automática de técnicos ni vinculación de invitados por teléfono no verificado. Los permisos de cuentas existentes se conservan.

## Activación y primer mensaje seguro

Aplica las migraciones antes de iniciar la nueva API y conecta el webhook a la nueva URL. Retira cualquier configuración antigua que apuntase directamente a Instafix desde Meta; la conexión de Meta la administra WasapFlow. No des de baja la cuenta ni la WABA.

1. Mantén `WHATSAPP_ENABLED=false` en el servidor para no activar citas reales.
2. Completa Coexistence y envía un saludo **desde un teléfono tuyo de prueba, distinto del empresarial**, al número de Instafix. Comprueba que aparezca como **Cliente** en administración. Eso abre la ventana de respuesta.
3. Desde la raíz del proyecto, ensaya sin enviar (sustituye el teléfono de ejemplo por el de prueba):

```sh
pnpm --filter @instafix/api whatsapp:test --to +593999123456
```

4. Solo cuando decidas enviar, ejecuta:

```sh
WHATSAPP_ENABLED=true pnpm --filter @instafix/api whatsapp:test --to +593999123456 --send
```

El flag habilita **únicamente ese proceso**, no cambia `.env` ni arranca workers. Envía un único texto explícito de prueba, verifica la ventana de 24 horas y no crea citas. Sin `--send` no llama a WasapFlow. Revisa la entrega en tu teléfono y en el panel del proveedor. Los mensajes aceptados no equivalen a entregados.

5. Con las plantillas aprobadas, prueba una cita controlada antes de habilitar el worker para clientes. Revisa la cola pendiente y la configuración de Cal.com; luego cambia `WHATSAPP_ENABLED=true` en el servidor y reinicia la API.

## Comprobaciones de desarrollo

```sh
pnpm build
pnpm test
pnpm format:check
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 src/tests/wasapflow.integration.test.ts src/tests/webhooks.integration.test.ts src/tests/whatsapp.integration.test.ts
```

Las pruebas usan mocks de WasapFlow y datos propios temporales. La prueba de onboarding requiere una base de desarrollo sin conexión real; se omite si detecta una WABA o alta pendiente. La cuenta y el número reales no se modifican.
