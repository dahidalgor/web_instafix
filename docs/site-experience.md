# Contacto, cuentas, presentaciones y métricas

## Activación

La migración `20261015120000_site_experience` añade nombres separados, contexto de reserva, relación de servicios con citas/trabajos, diapositivas y visitas. No elimina datos existentes. Los nombres anteriores se conservan completos: no se adivinan apellidos de cuentas antiguas.

En desarrollo, aplicar con las variables locales cargadas:

```sh
pnpm db:generate
pnpm --filter @instafix/api exec node -r dotenv/config ./node_modules/prisma/build/index.js migrate deploy --schema ../../database/schema.prisma dotenv_config_path=../../.env
```

En producción se debe aplicar la misma migración con el procedimiento de despliegue antes de arrancar la nueva API.

## Agendamiento y servicios

El cliente **no selecciona un servicio** al reservar: se mantiene el formulario de Cal.com con la descripción de su necesidad. Desde `Administración → Citas`, el técnico selecciona la cita, elige el servicio del catálogo y pulsa «Asignar servicio». Esto no cambia el horario ni la descripción enviada por el cliente.

Al terminar, `Administración → Trabajos` permite elegir cliente, cita opcional, servicio, precio final y condiciones/fechas de garantía. La operación guarda una instantánea del título, equipo y precio; completa la cita relacionada y cancela los mensajes pendientes. Una cita no puede producir dos registros de trabajo. Los servicios adicionales pueden registrarse como trabajos independientes. El historial solo pertenece a la cuenta seleccionada por el administrador, nunca a cualquier cuenta que declare el mismo teléfono.

La cuenta del cliente muestra la asignación del técnico y el historial de trabajos. Las reservas de invitados siguen sin apropiarse automáticamente de una cuenta. Su identidad debe comprobarse antes de registrar trabajos a su nombre.

## Datos de cuenta en el calendario

Al abrir Agenda, la web solicita `POST /api/v1/booking/context`. Para invitados devuelve contexto vacío. Para una sesión válida devuelve los datos del usuario y una referencia aleatoria de reserva. El servidor conserva solo el hash de la referencia, caducidad y usuario.

El embed recibe `name`, `email`, `attendeePhoneNumber` y `metadata[instafixReference]`. Es el mecanismo documentado de [prefill y metadata de Cal.com](https://cal.com/help/embedding/prefill-booking-form-embed). Los campos existentes de Cal.com no se cambian. No se premarca el consentimiento de WhatsApp.

El webhook firmado vincula la reserva solo si la referencia es válida y el correo verificado y teléfono coinciden con la cuenta. La referencia se consume para una reserva; acepta reintentos y reprogramaciones de esa reserva. Una referencia manipulada o reutilizada en otra cita no concede acceso al historial.

Se requiere mantener el webhook Cal.com configurado según `whatsapp-setup.md`. Sin ese webhook, el formulario se rellena pero la cita no puede aparecer automáticamente en PostgreSQL. Las reservas antiguas o realizadas fuera de la web no contienen esta referencia.

## Presentaciones

`Administración → Presentaciones` administra el slideshow de «Quiénes somos»: categoría, título, descripción, pie, archivo, posición y publicación. Cada diapositiva admite una foto o video; se pueden crear varias diapositivas. Las subidas reutilizan la conversión y almacenamiento existentes, local o R2. Menor posición aparece primero. Desmarcar «Publicada» retira la diapositiva sin eliminarla.

La migración conserva los tres textos originales como diapositivas publicadas. No inventa fotos de trabajos: hasta subirlas se mantienen las ilustraciones. La web consulta exclusivamente diapositivas publicadas; todos los cambios requieren una sesión ADMIN.

## Métricas

`Administración → Estadísticas` muestra los últimos 30 días: visitas por página, sesiones y tiempo promedio visible. Una navegación cuenta como visita; una pestaña conserva un identificador aleatorio en sessionStorage. No son personas únicas. Se acumula el tiempo con la pestaña visible, hasta cuatro horas por visita; no se mide atención real ni interacción dentro del iframe de Cal.com.

El cliente comunica el contador acumulado cada 15 segundos, al ocultar la pestaña y al salir. El backend impide duplicar tiempo con reintentos o eventos fuera de orden y limita el valor al tiempo transcurrido. Se respetan navegadores con «No rastrear». No se envían datos de cuenta, IP, URL libre ni contenido de formularios. Administración no se mide. Puede haber subregistro si se bloquea la red o el navegador termina abruptamente; estas métricas son orientativas.

Los registros mayores de 90 días se purgan al recibir nuevas visitas. El resumen solo es accesible con rol ADMIN.

## Verificación por correo con Brevo

Brevo es el proveedor elegido. El propietario confirmó el 16 de octubre de 2026 que los correos están activados y se reciben correctamente. Las credenciales no se guardan en el repositorio; cada entorno debe configurarlas por separado. La comprobación local realizada en esta sesión todavía encuentra vacías las variables SMTP de `.env`.

Los siguientes pasos permiten reproducir la configuración en otro entorno. Usar los datos y registros DNS entregados por Brevo; no inventar registros SPF/DKIM ni publicar contraseñas en DNS.

1. Usar la cuenta de Brevo y verificar el dominio con los registros que indique.
2. Usar la dirección remitente ya autorizada en Brevo. No asumir que cualquier dirección del dominio está habilitada.
3. Completar únicamente en `.env` local o en los secretos del servidor:

```dotenv
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
```

El puerto 465 usa TLS directo; otros puertos exigen STARTTLS. No se desactiva la verificación de certificados. `SMTP_FROM` puede ser `InstaFix <remitente-autorizado@instafix.ec>`.

4. Reiniciar API. En `Administración → Correo`, comprobar conexión: valida TLS y autenticación sin enviar mensajes. La pantalla solo muestra nombres de variables faltantes, nunca sus valores.
5. Crear una cuenta de prueba con un correo propio y comprobar recepción, carpeta de spam, verificación, reenvío y recuperación de contraseña. La comprobación SMTP por sí sola no demuestra entrega.

La verificación y recuperación usan códigos de seis dígitos, guardados como hash, con caducidad de diez minutos, cinco intentos y límites de reenvío. Un fallo de envío revierte el desafío y no crea la cuenta. No hay un código de prueba que salte la verificación en producción.

## Pruebas locales sin envíos reales

```sh
pnpm build
pnpm test
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test --test-concurrency=1 src/tests/site-experience.integration.test.ts src/tests/email-auth.integration.test.ts src/tests/whatsapp.integration.test.ts
```

Usar una base de desarrollo y mantener `WHATSAPP_ENABLED=false`. Estas pruebas crean y limpian sus datos temporales, simulan el correo y no contactan clientes reales.
