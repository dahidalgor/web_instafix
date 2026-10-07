# Arquitectura de InstaFix

La estructura de carpetas, responsabilidades, estilos y comandos de mantenimiento está documentada en [Organización del código](code-organization.md).

## Límites

La web presenta datos y llama a la API. El servidor valida y persiste. PostgreSQL es el registro propio de Instafix. Los futuros clientes móviles podrán consumir `/api/v1` y compartir los contratos sin depender de React web.

El catálogo relaciona `Offering` con `Equipment`. Cada servicio conserva también categoría y equipo descriptivos. Las cuentas usan `User` y `Session`; las citas internas usan `Appointment`, y los trabajos finalizados y sus garantías, `CompletedJob`. Los medios optimizados se guardan en disco o R2 y sus referencias permanecen en el catálogo.

## Confirmación futura

Solicitud → selección de técnico y horario → PENDIENTE_UBICACION → ubicación recibida por WhatsApp → cobertura y disponibilidad válidas → crear cita en Cal.com → registrar confirmación → notificar.

La confirmación requiere éxito verificable del proveedor. Un timeout necesita conciliación, no repetir ciegamente la creación. Webhooks deben verificarse sobre el cuerpo original, persistirse y deduplicarse. Eventos fuera de orden no pueden revertir estados. La referencia vincula la solicitud y el remitente debe coincidir o completar una verificación adicional.

El estado de agenda, de trabajo y de pago serán independientes. Recibir ubicación no significa trabajo aceptado ni pago realizado. Las coordenadas y dirección son datos privados y solo se compartirán con participantes autorizados.

## Identidad

Reservar no exige una cuenta ni correo. El teléfono se almacena en formato internacional, pero no es una clave primaria ni prueba automática de identidad. Cada solicitud inicial crea un cliente provisional para evitar apropiación de historiales. Las cuentas pueden registrarse con teléfono y contraseña; los trabajos se vinculan explícitamente después de comprobar la identidad. La API aplica permisos por rol en cada operación administrativa, independientemente del subdominio.

## Lo que falta antes de producción

La autenticación, los permisos y las pruebas de integración locales están implementados. Siguen pendientes la sincronización automática Cal.com/WhatsApp, verificación de teléfono y recuperación de acceso, credenciales y despliegue remoto, copias externas programadas y su restauración, retención de archivos huérfanos, observabilidad y protección distribuida contra abuso. Las citas internas se gestionan actualmente desde administración.
