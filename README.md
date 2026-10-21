# InstaFix

## Comunicaciones y verificación (17 de octubre de 2026)

Las cuentas se activan verificando el WhatsApp con un código (OTP) enviado por WhatsApp a través de Bird; el correo es opcional y se verifica desde Mi cuenta → Seguridad. La contraseña se recupera por WhatsApp o por correo verificados. La web reserva mediante la API de Cal.com (sin iframe) e Instafix envía por Brevo las confirmaciones, reprogramaciones y cancelaciones. Arquitectura, reglas de seguridad, pruebas y pasos manuales en [Comunicaciones](docs/communications.md).

Consulta la [guía de organización del código](docs/code-organization.md) para localizar componentes, estilos, controladores y contratos. Usa `pnpm format` para mantener el formato uniforme y `pnpm format:check` para comprobarlo.

## WhatsApp y Cal.com (14 de octubre de 2026)

Implementados los webhooks firmados, reservas de invitados, solicitud de ubicación, confirmación por técnico, cola persistente de mensajes y recordatorios a las 08:00 de Ecuador continental. Administración → WhatsApp muestra el número, las plantillas y el resultado de cada envío. La única integración de mensajería es **Bird** (`@messagebird/sdk`) con Coexistence: el número sigue en WhatsApp Business App. Requiere `BIRD_API_KEY`, el webhook de Bird registrado y plantillas aprobadas: consulta [la guía](docs/whatsapp-setup.md) y [la migración desde WasapFlow](docs/whatsapp-bird.md). Los envíos permanecen desactivados por defecto. Límites, presupuesto de WhatsApp y Cloudflare: [Seguridad y control de costos](docs/security-costs.md).

## Subida de archivos y despliegue (6 de octubre de 2026)

Administración → Servicios permite subir fotos y videos desde el dispositivo, previsualizar, ordenar y quitar contenido. Guarda el servicio para publicar los cambios. Almacenamiento local por defecto y adaptador R2 configurable; fotos WebP responsivas y videos MP4 optimizados con portada. Consulta [configuración y despliegue](deploy/README.md) para los límites, R2, Lightsail, migración y backups.

# Instafix

## Navegación y cuenta (4 de octubre de 2026)

La web tiene páginas con navegación por hash: Inicio, Servicios, Mi cuenta y Agenda. Inicio reúne la presentación (antes «Quiénes somos»), «Nuestro trabajo» y «Cómo funciona»; los enlaces antiguos `#quienes-somos`, `#nuestro-trabajo` y `#como` abren Inicio en esa sección. Los enlaces directos y Atrás/Adelante comparten el mismo estado de selección. Los colores siguen `prefers-color-scheme` del sistema; las animaciones y el carrusel respetan `prefers-reduced-motion`.

Las fichas abren un diálogo animado con galería continua de imágenes y videos HTTPS configurados en cada servicio. Los videos comienzan sin sonido; el movimiento puede pausarse y se detiene al interactuar. Sin medios cargados, no se inventan fotos ni aparece un carrusel vacío.

Mi cuenta muestra citas próximas e históricas, servicios realizados y garantías con fecha de vencimiento. Se consultan por el usuario autenticado, nunca por un teléfono enviado por el navegador. Administración → Citas permite registrar visitas de cuentas existentes o invitados. Las reservas de invitados no se vinculan por teléfono. Las realizadas con sesión iniciada usan una referencia opaca y el webhook firmado para vincularlas a la cuenta, comprobando correo y teléfono.

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

El catálogo, cuentas, garantías y agenda están implementados. Para producción faltan las credenciales y activación de los proveedores, el despliegue remoto y las comprobaciones reales. No incluye pagos, asignación automática de técnicos ni comprobación geográfica de cobertura.

El vencimiento está guardado; todavía no hay un proceso que cambie automáticamente el estado a EXPIRADA. No existe retención de horarios. Una repetición manual del envío puede crear otra solicitud; la idempotencia se incorporará antes de conectar proveedores.

Los clientes provisionales no se fusionan por teléfono no verificado. La futura activación de cuenta deberá verificar la propiedad y resolver números compartidos o reasignados.

## Próxima entrega

1. Activar y probar los proveedores externos en el dominio definitivo.
2. Verificación de propiedad del teléfono para vincular historiales de invitados.
3. Cobertura geográfica y asignación de técnicos.

Consultar `docs/architecture.md` para las reglas del flujo.

## Contacto, presentaciones y estadísticas

La web incluye Contacto en el footer y menú móvil desplegable. Administración permite editar las diapositivas, asignar servicios a citas, registrar trabajos y consultar visitas/tiempo visible por página. El cliente sigue describiendo su necesidad al reservar; el técnico elige el servicio después. Consulta [la guía de funcionamiento y configuración SMTP](docs/site-experience.md). El proveedor elegido es Brevo; el propietario confirmó la recepción de correos el 16 de octubre de 2026. Cada entorno necesita sus variables SMTP privadas.

## Agenda con Cal.com

La sección `#agenda` es un formulario propio de Instafix: consulta la disponibilidad real del evento `instafix/agenda-tu-cita-con-instafix` y crea la reserva mediante la API de Cal.com desde el backend. Cal.com ya no recibe el correo del cliente (ver [Comunicaciones](docs/communications.md)).

La sincronización con PostgreSQL y la confirmación por ubicación requieren activar los webhooks y configurar el evento como pendiente de confirmación según [la guía de WhatsApp](docs/whatsapp-setup.md). No hacer reservas ficticias en la agenda real para probarla.

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

Las cuentas se registran con WhatsApp, correo y contraseña y se activan al verificar el WhatsApp por OTP. Tras esa verificación, las reservas de invitado del mismo número (últimos 180 días) se asocian a la cuenta. Los trabajos completados siguen vinculándose explícitamente desde administración. Administración puede registrar trabajos completados vinculados explícitamente a una cuenta, después de comprobar la identidad. Cada trabajo conserva condiciones y fechas de garantía propias, independientes de cambios en la política pública.

Las fotos y videos se suben desde el dispositivo en administración; los enlaces HTTPS existentes también se conservan. El almacenamiento local y R2 están descritos en deploy/README.md. El calendario general de Cal.com no sincroniza automáticamente el precio del catálogo: su campo obligatorio `servicio` identifica el trabajo para los mensajes de WhatsApp.
