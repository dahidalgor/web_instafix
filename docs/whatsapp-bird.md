# WhatsApp con Bird · migración desde WasapFlow (fase 1: spike y gate)

Estado: **gate pendiente**. WasapFlow sigue siendo el proveedor activo y no se ha tocado. Bird solo
está instalado (`@messagebird/sdk` 0.99.0) y se prueba con `bird:spike`.

## Qué hay ya

| Pieza                                       | Para qué                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/whatsapp/bird/bird.client.ts` | Único archivo que importa el SDK. Lee `BIRD_API_KEY`, desactiva la telemetría (`Bird-Enrichment: 0`) y traduce los errores tipados del SDK a categorías de Instafix. |
| `apps/api/src/scripts/bird-spike.ts`        | Prueba de solo lectura (workspace, WABA, números, Coexistence, plantillas) y envío real opcional con seguimiento del estado.                                         |
| `BIRD_API_KEY=` en `.env.example`           | Solo backend. Nunca `VITE_*`, nunca en Git, logs ni tests.                                                                                                           |

## Cómo ejecutar el spike (en tu máquina)

1. En el `.env` de la raíz del repositorio: `BIRD_API_KEY=bk_xxxxxxxxx` → reemplaza `bk_xxxxxxxxx` por tu clave real (sin comillas).
2. Solo lectura: `pnpm --filter @instafix/api bird:spike`
3. Envío real a **un número tuyo autorizado**:
   `pnpm --filter @instafix/api bird:spike --to +5939XXXXXXXX --template <slug> --param valor --send`
   - Plantilla con variables con nombre: `--param nombre=Valor`.
   - Plantilla OTP con botón de copiar código: `--param 123456 --button-param 123456`.
   - El script espera hasta 60 s (`--wait`) y muestra la línea de tiempo accepted → sent → delivered → read.
4. Revisar un mensaje después: `pnpm --filter @instafix/api bird:spike --message <id>`

## Plantillas propuestas (crear en Bird → WhatsApp → Templates, idioma `es`)

| Slug                      | Categoría      | Variables                             | Texto propuesto                                                                                                                                         |
| ------------------------- | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phone_verification`      | Authentication | código (+ botón copiar código)        | Texto fijo de Meta: «{{1}} es tu código de verificación.» + aviso de seguridad + caducidad 10 min                                                       |
| `password_reset`          | Authentication | código (+ botón copiar código)        | Igual que el anterior (Meta no permite texto libre en Authentication)                                                                                   |
| `appointment_requested`   | Utility        | nombre, fecha, hora                   | «Hola {{nombre}}, recibimos tu solicitud de visita para el {{fecha}} a las {{hora}}. Responde a este chat con tu ubicación 📍 para preparar la visita.» |
| `appointment_confirmed`   | Utility        | nombre, fecha, hora, técnico          | «Hola {{nombre}}, tu visita del {{fecha}} a las {{hora}} está confirmada. Te atenderá {{tecnico}}.»                                                     |
| `appointment_rescheduled` | Utility        | nombre, fecha, hora                   | «Hola {{nombre}}, tu visita se movió al {{fecha}} a las {{hora}}. Te avisaremos cuando un técnico la confirme.»                                         |
| `appointment_cancelled`   | Utility        | nombre, fecha                         | «Hola {{nombre}}, tu visita del {{fecha}} fue cancelada. Puedes agendar otra en instafix.ec.»                                                           |
| `appointment_reminder`    | Utility        | nombre, cuándo («mañana»/«hoy»), hora | «Hola {{nombre}}, te recordamos tu visita de Instafix {{cuando}} a las {{hora}}.»                                                                       |
| `technician_on_the_way`   | Utility        | nombre, técnico                       | «Hola {{nombre}}, {{tecnico}} va en camino a tu dirección.»                                                                                             |

Los textos definitivos y el mapeo de variables se fijan al implementar el proveedor; la aprobación
la da Meta (estado visible en el spike).

## Pasos manuales en Bird / Meta (no automatizables)

1. **Bird → Settings → API keys**: crear la clave con permisos de WhatsApp y copiarla al `.env` (no al chat).
2. **Bird → Channels / Numbers → WhatsApp → Connect**: elegir **«Connect existing WhatsApp Business app number» / Coexistence**
   y completar el Embedded Signup de Meta con el número de Instafix. Esto **no borra** la app Business ni el historial;
   Meta sincroniza hasta ~6 meses de historial y exige abrir la app al menos cada 14 días.
   - No elijas el flujo de «número nuevo» con el número actual: ese es el que da «número ya asociado» y exigiría quitar el número de la app.
   - Si Meta no ofrece Coexistence para el número (país o tipo de cuenta), **detente**: el plan B es un número nuevo dedicado a la API.
3. Crear las plantillas de la tabla y esperar su aprobación.
4. Webhooks (cuando se implemente el receptor): registrar `https://api.instafix.ec/api/v1/webhooks/bird`
   con los eventos `whatsapp.sent/delivered/read/failed/rejected/received` y guardar el secreto como `BIRD_WEBHOOK_SECRET`.

## Gate (criterios para desmontar WasapFlow)

Envío real de plantilla entregado · número de Instafix conectado (Coexistence o plan B aceptado) ·
plantillas Utility y Authentication aprobadas · OTP recibido · webhook firmado recibido (inbound y estados).
Hasta que el spike muestre «sí» en lo crítico, WasapFlow no se elimina.
