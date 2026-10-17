# Correo transaccional — revisión 17 de octubre de 2026

## Hallazgos comprobados

- DNS público de instafix.ec: código de verificación Brevo publicado; brevo1 y brevo2._domainkey apuntan a Brevo y resuelven claves DKIM.
- `_dmarc.instafix.ec`: `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`. Es supervisión, no rechazo. No endurecer hasta revisar todos los emisores y sus informes.
- No hay SPF en el dominio raíz. Esto no demuestra un fallo de SPF de los mensajes: Brevo puede usar su propio Return-Path. No añadir include ni un segundo SPF sin revisar los encabezados reales y el esquema que muestra la cuenta de Brevo.
- El SMTP local está configurado con host de Brevo y From del dominio instafix.ec. Reply-To no está configurado. Añadido soporte opcional `SMTP_REPLY_TO`: usar solo un buzón real y atendido. Sin él, las respuestas usan From.
- Verificación SMTP sin envío: falla con ESOCKET en CONN y error de validación de certificado, antes de confirmar autenticación. Comprobar cadena de confianza del entorno Node/red sin desactivar la verificación TLS. No prueba que las credenciales sean incorrectas ni que producción tenga el mismo problema. No se deshabilitó TLS.
- Logo público devuelve HTTP 200 como image/png.

La autenticación DNS observada no garantiza bandeja de entrada. Revisar en un mensaje recibido `Authentication-Results` (spf, dkim, dmarc), dominio `d=` de DKIM, Return-Path y From. En Brevo revisar estado del dominio/remitente, eventos de entrega, rebotes, bloqueos y quejas. No se ha accedido a esos registros privados.

Referencias oficiales:

- https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC
- https://help.brevo.com/hc/en-us/articles/35852083084178-Domain-setup-for-better-email-deliverability

## Confirmación de cita no recibida

Caso informado: reserva en instafix.ec para viernes 16 de octubre de 2026 a las 15:00 (Ecuador). La base local tiene cero citas y cero eventos Cal, y no tiene CAL_API_KEY, CAL_EVENT_TYPE_ID ni CAL_WEBHOOK_SECRET. No representa el servidor publicado.

El backend solo enviaba por SMTP códigos de registro y recuperación. No existía correo independiente de bienvenida ni de cita. La confirmación de cita corresponde a Cal.com. El worker requiere WhatsApp/WasapFlow y Cal configurados y activos; después de la ubicación confirma Cal. En local WHATSAPP_ENABLED=false, por lo que no ejecuta esa confirmación.

Para resolver el caso real, revisar en modo lectura:

1. Encontrar la reserva por fecha/hora y cliente en Cal: pendiente, aceptada, cancelada o ausente; comprobar correo del asistente.
2. Revisar entrega de webhook y cita/cola CAL_CONFIRM en el servidor publicado, sin volcar datos personales ni tokens.
3. Si está pendiente, identificar si falta ubicación, conexión WasapFlow o confirmación Cal. No marcarla confirmada para forzar un correo.
4. Si está aceptada, revisar confirmación al asistente y workflows de Cal. Buscar el envío en el proveedor correspondiente: Brevo no contiene los mensajes que Cal envía por su cuenta.
5. Si hay envío, revisar rechazo/bounce/spam y encabezados del destinatario.

No se ha demostrado todavía la causa del caso de producción. No se modificó Cal ni DNS, ni se envió ningún mensaje real.

## Diseño y responsabilidad

`apps/api/src/mail/templates.ts` centraliza HTML con tablas, estilos inline, ancho máximo 600 px, logo PNG, colores de marca, botón, contacto y footer. Cada mensaje tiene versión de texto. Los códigos no van en enlaces. Registro da la bienvenida antes de verificar, sin afirmar que la cuenta ya está verificada.

Registro/verificación y recuperación usan ya esta plantilla a través del transporte existente. `appointmentEmail` está preparado y tiene pruebas, pero no está conectado a un envío SMTP. Cal sigue siendo el único emisor de confirmación para evitar duplicados. Los ejemplos de docs/email-previews usan datos ficticios.

Para aplicar el diseño a confirmaciones reales hay que decidir una única fuente: personalización compatible con el plan de Cal, o desactivar su confirmación y activar un envío duradero/deduplicado desde Instafix después de la confirmación efectiva. Esa modificación externa requiere aprobación previa del propietario. No basta con añadir sendMail a un webhook.

No hace falta crear un subdominio de envío para corregir estos hallazgos. Si se separan campañas comerciales de transaccionales en el futuro, configurar el subdominio y sus registros exactos desde Brevo; no cambiar ahora el dominio autenticado.

## Validación pendiente

Pruebas de contenido y compilación locales; no equivalen a pruebas reales en Outlook/Gmail/Apple Mail. Antes de activar en producción, enviar solo a buzones propios autorizados, comprobar móvil, imágenes bloqueadas, texto alternativo y códigos. Confirmar alineación DKIM/DMARC y revisar los eventos de entrega. Publicar el código no modifica por sí mismo plantillas alojadas en Cal.
