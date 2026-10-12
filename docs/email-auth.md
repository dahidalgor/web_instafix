# Correo de autenticación

El acceso continúa siendo por teléfono. Los nuevos registros requieren correo válido y un código de seis cifras para crear la cuenta. El correo se normaliza a minúsculas y es único. Verificar correo no acredita la propiedad del teléfono ni vincula trabajos históricos automáticamente.

## Activar SMTP

Completar en `.env` (o `.env.production` en el servidor):

```dotenv
SMTP_HOST=smtp.tu-proveedor.com
SMTP_PORT=587
SMTP_USER=usuario-del-proveedor
SMTP_PASSWORD=clave-del-proveedor
SMTP_FROM=InstaFix <cuentas@tu-dominio.com>
```

El puerto 465 utiliza TLS directo; el 587 exige STARTTLS. No se desactiva la validación de certificados. Configurar el remitente y los registros SPF/DKIM según el proveedor, reiniciar la API y realizar un registro con un correo propio para comprobar recepción y spam. No hay credenciales ni envío real configurados todavía.

Sin SMTP, registrar y reenviar muestran un error y no crean una cuenta. No se imprimen códigos en consola ni se devuelven en la API. El adaptador SMTP usa [Nodemailer](https://nodemailer.com/smtp).

## Seguridad y comportamiento

- Códigos de un uso, caducidad de 10 minutos y 5 intentos por código.
- Máximo 5 solicitudes por correo y hora, separadas al menos un minuto, además del límite por IP de la API.
- El reenvío invalida el código anterior. Los hashes incluyen sal; consumo y cambio de contraseña son transaccionales.
- Recuperar requiere un correo ya verificado y cierra todas las sesiones anteriores.
- La recuperación responde de forma genérica para correos desconocidos.
- Las cuentas antiguas sin correo conservan su acceso por teléfono, pero no pueden recuperar por correo hasta disponer de uno verificado. No se inventan correos ni se marcan como verificados.
- Los desafíos permanecen como historial del límite de envíos. Programar limpieza de desafíos antiguos cuando se configure la operación del servidor.

## Verificación local

`pnpm test` y `pnpm build` comprueban contratos y compilación. Para las pruebas con PostgreSQL, ejecutar:

```sh
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test src/tests/email-auth.integration.test.ts
```

La prueba usa un remitente simulado en memoria; verifica creación diferida, caducidad, intentos, reenvío, consumo concurrente y cierre de sesiones, sin enviar correo real. Limpia únicamente sus datos temporales.
