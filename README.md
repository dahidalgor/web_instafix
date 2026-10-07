# InstaFix

Consulta la [guía de organización del código](docs/code-organization.md) para localizar componentes, estilos, controladores y contratos. Usa `pnpm format` para mantener el formato uniforme y `pnpm format:check` para comprobarlo.

## Subida de archivos y despliegue (6 de octubre de 2026)

Administración → Servicios permite subir fotos y videos desde el dispositivo, previsualizar, ordenar y quitar contenido. Guarda el servicio para publicar los cambios. Almacenamiento local por defecto y adaptador R2 configurable; fotos WebP responsivas y videos MP4 optimizados con portada. Consulta [configuración y despliegue](deploy/README.md) para los límites, R2, Lightsail, migración y backups.

# Instafix

## Navegación y cuenta (4 de octubre de 2026)

La web tiene páginas independientes con navegación por hash: Inicio, Servicios, Quiénes somos, Cómo funciona, Mi cuenta y Agenda. Los enlaces directos y Atrás/Adelante comparten el mismo estado de selección. Los colores siguen `prefers-color-scheme` del sistema; las animaciones y el carrusel respetan `prefers-reduced-motion`.

Las fichas abren un diálogo animado con galería continua de imágenes y videos HTTPS configurados en cada servicio. Los videos comienzan sin sonido; el movimiento puede pausarse y se detiene al interactuar. Sin medios cargados, no se inventan fotos ni aparece un carrusel vacío.

Mi cuenta muestra citas próximas e históricas, servicios realizados y garantías con fecha de vencimiento. Se consultan por el usuario autenticado, nunca por un teléfono enviado por el navegador. Administración → Citas permite registrar y editar citas asociadas a cuentas existentes. La migración `202610040001_appointments` añade esta tabla sin alterar trabajos previos. La sincronización automática con Cal.com/WhatsApp todavía no está conectada: estas citas se registran en Instafix desde administración, después de comprobar la identidad del cliente.

Pruebas de permisos de citas contra una API local en ejecución (crea y elimina exclusivamente sus propias cuentas y citas de prueba):

```sh
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test src/tests/appointments.integration.test.ts
```

Primera entrega local: React + TypeScript, API NestJS y modelo PostgreSQL con Prisma.

## Requisitos

Node.js 22 LTS, pnpm 11 y Docker Desktop (o PostgreSQL 17 local).

Ejecuta todos estos comandos desde `/Users/daviti/Documents/Desarrollo/web_instafix`:

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate --name initial
pnpm --filter @instafix/api db:seed
pnpm dev
```

Web: http://localhost:5173. API: http://localhost:3001/api/v1/health.
Prisma toma la configuración de `.env` en la raíz. Las credenciales del ejemplo son únicamente para desarrollo local. No uses `docker compose down -v` si necesitas conservar los datos.

## Comprobaciones

```sh
pnpm test
pnpm build
```

## Qué funciona

- Catálogo ilustrativo responsive y formulario de invitado.
- Validación compartida y validación obligatoria en servidor.
- API `POST /api/v1/requests`: crea cliente provisional y solicitud pendiente en PostgreSQL, de forma atómica.
- Precio tomado de la oferta del servidor, nunca del navegador.
- Consentimiento, teléfono internacional, referencia opaca y vencimiento de 30 minutos.
- Límite básico de peticiones. Sin endpoint público de búsqueda por teléfono.

## Límites de esta entrega

No es una plataforma lista para producción. No incluye selección de técnico/horario, autenticación, garantías, confirmación, Cal.com, WhatsApp ni pagos. No se envían mensajes ni se crean citas. Los precios son datos de demostración, no tarifas aprobadas. El frontend muestra el catálogo de demostración compartido; conectar su lectura al catálogo de la API es parte de la próxima fase.

El vencimiento está guardado; todavía no hay un proceso que cambie automáticamente el estado a EXPIRADA. No existe retención de horarios. Una repetición manual del envío puede crear otra solicitud; la idempotencia se incorporará antes de conectar proveedores.

Los clientes provisionales no se fusionan por teléfono no verificado. La futura activación de cuenta deberá verificar la propiedad y resolver números compartidos o reasignados.

## Próxima entrega

1. Catálogo relacional de categorías/dispositivos y técnicos verificados.
2. Integración Cal.com para selección de horarios sin confirmación prematura.
3. Recepción autenticada de ubicación por WhatsApp, validación de cobertura y disponibilidad.
4. Creación idempotente de cita y notificaciones con reintentos.

Consultar `docs/architecture.md` para las reglas del flujo.

## Agenda Cal.com integrada

La sección `#agenda` muestra el evento real `instafix/agenda-tu-cita-con-instafix` mediante su vista incrustada en un iframe. Conserva `overlayCalendar=true` y omite la fecha fija del enlace original. No se cambian los ajustes de la cuenta de Cal.com.

Esta integración visual permite actuar sobre la agenda real según sus reglas actuales. Aún no sincroniza reservas con PostgreSQL ni condiciona la confirmación a recibir ubicación por WhatsApp. No hacer reservas ficticias para probarla.

## Catálogo, cuentas y administración (octubre 2026)

El catálogo público ahora se obtiene exclusivamente de PostgreSQL. No hay datos ficticios de respaldo. `Equipment` agrupa ofertas con descripción, precio, disponibilidad, garantía anunciada y medios HTTPS (imágenes y archivos de video). Los estados son AVAILABLE, UNAVAILABLE y COMING_SOON; la API impide solicitar ofertas no disponibles.

En la raíz, configura `.env` con un usuario PostgreSQL autorizado:

```dotenv
DATABASE_URL=postgresql://USUARIO:CONTRASENA_CODIFICADA@localhost:5432/instafix
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://admin.localhost:5173
```

No compartas ni versiones `.env`. Los caracteres especiales de la contraseña deben codificarse para una URL. Con la conexión preparada, ejecuta desde `/Users/daviti/Documents/Desarrollo/web_instafix`:

```sh
pnpm db:generate
pnpm --filter @instafix/api exec prisma migrate deploy --schema ../../database/schema.prisma
pnpm --filter @instafix/api db:seed
pnpm --filter @instafix/api admin:create
pnpm dev
```

El comando de administrador pide teléfono y contraseña de forma interactiva; la contraseña no se muestra. No hay administrador ni contraseña predeterminados. No convierte cuentas de cliente existentes en administradores.

- Web: http://localhost:5173
- Administración: http://admin.localhost:5173 (sin enlace público)
- Mi cuenta: http://localhost:5173/#cuenta
- Garantías: http://localhost:5173/#garantia

El acceso administrativo se verifica por rol en cada endpoint, independientemente del hostname. El subdominio no es una medida de autorización. Para producción hay que configurar DNS/TLS y `VITE_ADMIN_HOST`, los orígenes permitidos y NODE_ENV=production. Las cookies son de host, HttpOnly, SameSite=Strict y Secure en producción; las sesiones caducan en 24 horas y se revocan al salir. Contraseñas con scrypt y sal aleatoria. No se guarda el token de sesión en texto claro.

Las cuentas se registran con teléfono y contraseña, sin correo obligatorio. La verificación de propiedad del teléfono y recuperación de contraseña aún requieren conectar un proveedor. Por eso no se reclaman trabajos de invitados automáticamente por coincidencia de teléfono. Administración puede registrar trabajos completados vinculados explícitamente a una cuenta, después de comprobar la identidad. Cada trabajo conserva condiciones y fechas de garantía propias, independientes de cambios en la política pública.

Las fotos y videos se suben desde el dispositivo en administración; los enlaces HTTPS existentes también se conservan. El almacenamiento local y R2 están descritos en deploy/README.md. El calendario general de Cal.com sigue separado del catálogo: no sincroniza automáticamente el precio ni el servicio elegido, y su confirmación sigue requiriendo la integración con WhatsApp prevista.
