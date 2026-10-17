# Correo de autenticación

Sustituido el 17 de octubre de 2026. El registro ya no usa un código por correo: la cuenta se activa verificando el WhatsApp. El correo es opcional, se verifica con un enlace desde Mi cuenta → Seguridad y permite recuperar la contraseña por correo. Consulta [Comunicaciones](communications.md).

## Activar SMTP (Brevo)

Completar en `.env` (o `.env.production` en el servidor):

```dotenv
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=usuario-smtp-de-brevo
SMTP_PASSWORD=clave-smtp-de-brevo
SMTP_FROM=Instafix <remitente-autorizado@instafix.ec>
SMTP_REPLY_TO=
```

El puerto 465 utiliza TLS directo; el 587 exige STARTTLS. No se desactiva la validación de certificados. Sin SMTP, las acciones que envían correo devuelven un error y no afirman ningún envío. La tabla `EmailChallenge` se conserva como historial y ya no se usa.
