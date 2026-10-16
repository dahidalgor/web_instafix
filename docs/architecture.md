# Arquitectura de InstaFix

La estructura de carpetas, responsabilidades, estilos y comandos de mantenimiento está documentada en [Organización del código](code-organization.md).

## Límites

La web presenta datos y llama a la API. El servidor valida y persiste. PostgreSQL es el registro propio de Instafix. Los futuros clientes móviles podrán consumir `/api/v1` y compartir los contratos sin depender de React web.

El catálogo relaciona `Offering` con `Equipment`. Cada servicio conserva también categoría y equipo descriptivos. Las cuentas usan `User` y `Session`; las citas internas usan `Appointment`, y los trabajos finalizados y sus garantías, `CompletedJob`. Los medios optimizados se guardan en disco o R2 y sus referencias permanecen en el catálogo.

## Confirmación y mensajería

`WhatsAppModule` reúne el transporte único: lógica de negocio → `WhatsAppService` → `WasapFlowClient` → WasapFlow Bridge. La conexión se realiza con Embedded Signup alojado y exige Coexistence. `WhatsAppConnection` conserva la WABA verificada; `BridgeWebhook` es la bandeja durable; `WhatsAppMessage` y `WhatsAppContact` sincronizan mensajes/contactos sin mezclar su identidad con la de cuentas web.

Reserva pendiente en Cal.com → webhook firmado → `Appointment` pendiente de ubicación → ubicación nativa del cliente por WhatsApp → confirmar reserva mediante API Cal.com → registrar confirmación → notificar y programar recordatorios. La cobertura y asignación de técnico no se validan automáticamente en esta versión.

`AutomationJob` conserva la cola y una clave única por cita, revisión y tipo de mensaje. `IntegrationEvent` deduplica eventos y conserva recibos de entrega. Bloqueos de PostgreSQL serializan cambios por cita y evitan procesar dos veces el mismo mensaje. Cancelar o reprogramar invalida la revisión anterior. Los detalles operativos están en [WhatsApp y Cal.com](whatsapp-setup.md).

La confirmación requiere éxito verificable del proveedor. Un timeout necesita conciliación, no repetir ciegamente la creación. Webhooks deben verificarse sobre el cuerpo original, persistirse y deduplicarse. Eventos fuera de orden no pueden revertir estados. La referencia vincula la solicitud y el remitente debe coincidir o completar una verificación adicional.

El estado de agenda, de trabajo y de pago serán independientes. Recibir ubicación no significa trabajo aceptado ni pago realizado. Las coordenadas y dirección son datos privados y solo se compartirán con participantes autorizados.

## Identidad

Reservar no exige una cuenta ni correo. El teléfono se almacena en formato internacional, pero no es una clave primaria ni prueba automática de identidad. Cada solicitud inicial crea un cliente provisional para evitar apropiación de historiales. Las cuentas pueden registrarse con teléfono y contraseña; los trabajos se vinculan explícitamente después de comprobar la identidad. La API aplica permisos por rol en cada operación administrativa, independientemente del subdominio.

## Lo que falta antes de producción

La autenticación, recuperación por correo, permisos e integración Cal.com/WhatsApp están implementados y tienen pruebas locales. Siguen pendientes la activación real de SMTP y mensajería, verificación de teléfono, credenciales y despliegue remoto, copias externas programadas y su restauración, retención de archivos huérfanos, observabilidad y protección distribuida contra abuso.
