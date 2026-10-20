# Migración de WhatsApp: WasapFlow → Bird · 20–21 de octubre de 2026

Estado: **completada**. Bird es el único proveedor; WasapFlow se retiró del código, la base y la configuración. Guía operativa: [whatsapp-setup.md](whatsapp-setup.md).

## Gate (prueba real antes de desmontar WasapFlow)

Ejecutado con `bird:spike` desde la máquina del administrador (la clave nunca salió del `.env`):

| Requisito                                           | Resultado                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SDK oficial `@messagebird/sdk` y autenticación      | ✓ (región `us1`)                                                                               |
| Número de Instafix conectado en Bird                | ✓ `+593…819`, `connected`, límite `tier_250`                                                   |
| Coexistence (app Business + API en el mismo número) | ✓ `is_on_business_app: true`                                                                   |
| Plantillas Utility aprobadas                        | ✓ 5/5 (`es-EC`; `appointment_requested` en `es`)                                               |
| Envío real de plantilla propia desde el número      | ✓ `appointment_confirmed`: accepted → sent → delivered en 4 s                                  |
| OTP                                                 | ✓ `bird_otp` (gestionada por Bird): delivered en 6 s                                           |
| Webhooks firmados                                   | Verificado con pruebas (firmas Standard Webhooks reales); falta registrar la URL en producción |

Hallazgos: el primer envío falló con Meta `(#100) Invalid parameter` porque se envió desde el número de Instafix a sí mismo. `phone_verification` fue rechazada por Meta; se usa `bird_otp`. Se decidió no usar `password_reset` ni `technician_on_the_way`.

## Decisiones

- **SDK 0.99.0** fijado: 0.100.0 se publicó el mismo día y la política `minimumReleaseAge` de pnpm lo bloquea.
- **Sin botón «Conectar WhatsApp»**: con Bird el número se conecta una vez en su panel (Numbers → WhatsApp → Coexistence). Se eliminaron el popup, `whatsapp-connect.html` y los endpoints `connect/*`.
- **Plantillas en código, idioma y variables desde Bird**: el texto se edita en Bird sin desplegar; Instafix comprueba que la plantilla solo use sus variables con nombre.
- **Resultados inciertos no se reenvían** (tiempo agotado, 5xx): quedan en revisión. El SDK reintenta con la misma clave de idempotencia.
- **Avisos retirados**: «técnico asignado», «técnico en camino» y el botón de Administración → Citas que lo enviaba.

## Base de datos (migración `20261021120000_whatsapp_bird`)

Sin pérdida de historial:

| Antes                              | Ahora                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `AutomationJob.providerId`         | `providerMessageId` + `provider` (`WASAPFLOW` en lo existente)           |
| `deliveryStatus` `sent/read…`      | `SENT/DELIVERED/READ/FAILED`                                             |
| `WhatsAppMessage.wabaId/messageId` | `accountId/providerMessageId` + `provider` (`WASAPFLOW` en lo existente) |
| `WhatsAppContact.wabaId`           | `accountId` (historial; Bird no sincroniza contactos)                    |
| `BridgeWebhook`                    | `WhatsAppWebhook` + `provider`; lo pendiente de WasapFlow → `DISCARDED`  |
| `WhatsAppConnection`               | eliminada (era el estado del popup, no historial)                        |

## Archivos

Nuevos: `whatsapp/provider.ts`, `whatsapp/bird/bird.client.ts`, `whatsapp/bird/bird.provider.ts`, `whatsapp/webhook-inbox.ts`, `scripts/bird-spike.ts` (`whatsapp:diagnose`), pruebas `bird-provider.test.ts`, `bird-webhooks.integration.test.ts`, `support/bird-webhooks.ts`.

Eliminados: `wasapflow.client.ts`, `connection.ts`, `onboarding.service.ts`, `bridge-webhooks.ts`, `scripts/diagnose-whatsapp.ts`, `scripts/test-whatsapp.ts`, `web/public/whatsapp-connect.html`, pruebas de WasapFlow, `docs/whatsapp-migration-audit.md`, `docs/whatsapp-templates.json`.

## Producción

1. Copia de seguridad de PostgreSQL.
2. En `.env.production`: añadir `BIRD_API_KEY`, `BIRD_WEBHOOK_SECRET` y revisar `WHATSAPP_BUSINESS_PHONE`. Las `WASAPFLOW_*` y `WHATSAPP_TEMPLATE_*` dejan de leerse; puedes borrarlas cuando confirmes que Bird funciona.
3. Desplegar y aplicar la migración **antes** de levantar la nueva API (el código nuevo no funciona con el esquema anterior):
   ```sh
   docker compose --env-file .env.production -f compose.production.yaml build
   docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm exec prisma migrate deploy --schema /app/database/schema.prisma
   docker compose --env-file .env.production -f compose.production.yaml up -d
   ```
4. Registrar el webhook de Bird (ver guía) y usar «Enviar prueba».
5. En el panel de WasapFlow, desactivar su webhook hacia Instafix. **No** des de baja el número ni la WABA desde WasapFlow sin consultarlo: comprueba antes que no afecta a la conexión Coexistence de Bird.
6. Administración → WhatsApp: número conectado, Coexistence «sí», 5 plantillas aprobadas.
7. `WHATSAPP_OTP_ENABLED=true` → probar registro con un número propio. Después `WHATSAPP_ENABLED=true` → cita de prueba con tu número y confirmarla como técnico.
