# Auditoría y migración a WasapFlow · 14 de octubre de 2026

## Inventario anterior a los cambios

Se revisaron referencias de WhatsApp/Meta en API, frontend, contratos, esquema/migraciones, pruebas, scripts, configuración y documentación. El repositorio ya contenía cambios locales de la integración anterior; se conservaron los cambios ajenos a esta migración.

- `whatsapp/providers.ts`: mezclaba envío directo por Graph API con confirmación de reservas Cal.com.
- `integrations/webhooks.controller.ts`: desafío GET de Meta, firma con App Secret y recepción de su envelope `entry/changes`.
- `whatsapp/inbound.ts`: combinaba interpretación del payload Meta con la lógica funcional de ubicación y confirmación.
- `config.ts`, ejemplos de entorno y guía: requerían credenciales directas de Meta.
- Pruebas de proveedor y HTTP usaban esos contratos anteriores.
- `messages.ts`, `queue.ts`, `worker.ts`, `delivery.ts`, controlador de citas y webhook Cal.com contenían lógica de negocio válida y persistencia que había que conservar.
- No se encontró un segundo SDK, adaptador experimental, endpoint de envío temporal ni dependencia exclusiva de Meta. `zod` continúa siendo necesario para contratos de Cal.com y Bridge.

## Eliminado y sustituido

Se eliminó `providers.ts` y su artefacto compilado obsoleto. Se retiraron el transporte Graph, el desafío GET, el parser del envelope directo, variables directas y documentación de alta anterior. No existe registro manual de WABA en el código ni uso de códigos/tokens Meta desde Instafix.

La confirmación Cal.com pasó a `integrations/cal-client.ts`, con el mismo comportamiento. `ProviderError` se aisló en `integrations/provider-error.ts`. La recepción de ubicación ahora recibe un mensaje normalizado en `inbound.ts`; no conoce headers de WasapFlow.

## Arquitectura final y archivos

| Responsabilidad                                            | Archivos                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Composición Nest                                           | `whatsapp/whatsapp.module.ts`, `app.module.ts`                                                                                     |
| Interfaz de negocio, templates y ventana de texto          | `whatsapp/whatsapp.service.ts`; textos originales en `messages.ts`                                                                 |
| Transporte único y validación del enlace temporal          | `whatsapp/wasapflow.client.ts`                                                                                                     |
| Sesión de onboarding, estado de uso único, WABA persistida | `whatsapp/onboarding.service.ts`, `connection.ts`                                                                                  |
| Webhook firmado y bandeja durable                          | `integrations/webhooks.controller.ts`, `whatsapp/bridge-webhooks.ts`                                                               |
| Cola/estados existentes adaptados                          | `whatsapp/worker.ts`, `delivery.ts`, `config.ts`; `queue.ts` conserva su comportamiento                                            |
| Administración y actividad de mensajes                     | `whatsapp/admin.controller.ts`, `apps/web/src/features/admin/AdminWhatsApp.tsx`                                                    |
| Persistencia aditiva                                       | `database/schema.prisma`, migración `20261014120000_wasapflow_bridge`                                                              |
| Prueba manual sin workers                                  | `apps/api/src/scripts/test-whatsapp.ts`, script `whatsapp:test`                                                                    |
| Pruebas                                                    | `whatsapp.test.ts`, `whatsapp.integration.test.ts`, `webhooks.integration.test.ts`, `wasapflow.integration.test.ts`                |
| Configuración y guía                                       | `.env.example`, `deploy/production.env.example`, `.gitignore`, README, arquitectura, organización del código y `whatsapp-setup.md` |

Las tablas nuevas son `WhatsAppConnection`, `BridgeWebhook`, `WhatsAppMessage` y `WhatsAppContact`. No se borraron citas, usuarios, servicios ni historiales. La migración anterior se conserva como historia de la base de datos.

## Flujos y mensajes conservados

1. Reserva válida → mensaje con nombre, descripción, fecha y hora que pide ubicación.
2. Ubicación del cliente → confirmación Cal.com → mensaje «Listo estimado…» y recordatorios.
3. Día anterior a las 08:00 → recordatorio «Instafix le recuerda…».
4. Mismo día a las 08:00 → aviso completo «Estimad@…», incluidos comunicación del técnico, horario estimado, servicios previos y traslados.
5. Cancelación/reprogramación → invalidación de avisos del horario anterior; deduplicación y reintentos preservados.

No había un disparador separado de técnico en camino/asignado ni aviso de cancelación. No se presenta como implementado. Los cuerpos de `messages.ts` y `whatsapp-templates.json` no se cambiaron por textos genéricos.

## Seguridad y límites de activación

El escaneo de archivos actuales y las dos revisiones disponibles de Git no encontró credenciales de Meta/WasapFlow ni claves privadas hardcodeadas. `.env` no estaba versionado; se amplió la exclusión a variantes locales. No se identificó una credencial expuesta que requiera rotación. No se imprimieron valores del entorno ni se ejecutaron operaciones de alta/baja/envío reales.

La Partner Key solo reside en el backend. El navegador recibe un enlace temporal y un estado opaco; el resultado exige sesión ADMIN, origen permitido, estado asociado al administrador, caducidad y uso único. La conexión requiere Coexistence. La lista de WABAs del proveedor verifica pertenencia/estado y, cuando lo incluye, modo; el modo también se exige en la configuración de onboarding y el callback oficial. Esta integración no puede comprobar la configuración de una cuenta real mientras no se complete el alta.

Se conservan firmas HMAC, selección de la WABA verificada, procesamiento idempotente y protección contra bucles de ecos/historial. Los datos sincronizados se muestran solo a administradores. Los eventos desconocidos no ejecutan negocio; los medios históricos se presentan por tipo y no se descargan automáticamente.

La [guía de activación y primera prueba](whatsapp-setup.md) especifica las variables, pasos manuales y cómo enviar una prueba desde un proceso aislado manteniendo desactivada la automatización del servidor.
