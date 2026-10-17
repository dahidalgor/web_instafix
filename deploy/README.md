# Publicación en Lightsail y R2

Preparación disponible; no se han contratado ni creado recursos externos.

## Desarrollo local

`MEDIA_STORAGE=local` es el valor predeterminado. Las subidas se guardan en `storage/media`, fuera del repositorio. Instalar FFmpeg (incluye ffprobe) y ejecutar `pnpm dev`. Las imágenes se convierten a WebP (1600 px y versión de 640 px); los videos de hasta 60 segundos se convierten a MP4 H.264 hasta 1280×720, sin audio, con inicio progresivo y portada. Límites: 20 MB por foto y 100 MB por video. Solo un archivo se procesa simultáneamente para limitar consumo de CPU.

Administración → Servicios → editar → Subir desde mi dispositivo → ordenar/describir → Guardar servicio. Quitar contenido lo desvincula del servicio; el archivo físico se conserva para evitar borrar referencias compartidas. Los archivos subidos sin guardar también se conservan; revisar periódicamente el almacenamiento. Guardar una copia de los originales fuera de la web.

## Cloudflare R2

1. Crear un bucket Standard y un token S3 con lectura/escritura restringido a ese bucket.
2. Vincular un dominio público, por ejemplo `media.tudominio.com`, al bucket desde Cloudflare y activar una regla de caché para los archivos. El contenido del catálogo será público.
3. Configurar las cinco variables R2 del ejemplo en el servidor. Las credenciales nunca se envían al navegador. La subida pasa por la API autenticada, que valida y optimiza antes de guardar en R2.
4. Para probar R2 desde el Mac, configurar también `MEDIA_STORAGE=r2` en `.env` y reiniciar la API.

Los archivos locales previos no se migran automáticamente: volver a subirlos con R2 activo antes de publicar, o mantener un almacenamiento local persistente y copiar los archivos al servidor. No borrar el directorio local hasta comprobar todas las referencias.

## Lightsail

Crear una instancia Ubuntu con 4 GB RAM y dirección IPv4 estática. Instalar Docker Engine y el complemento Compose. Abrir 80/443 y restringir SSH a la IP administrativa. PostgreSQL y la API no publican puertos externos.

Apuntar los registros DNS de la web y del subdominio administrativo a la IP estática. Copiar el proyecto al servidor, sin `.env`, `storage` ni `node_modules`. Copiar `deploy/production.env.example` a `.env.production` y completar dominios, contraseña hexadecimal larga y credenciales R2. Proteger el archivo con permisos 600.

Desde la raíz del proyecto:

```sh
docker compose --env-file .env.production -f compose.production.yaml build
docker compose --env-file .env.production -f compose.production.yaml up -d db
docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm exec prisma migrate deploy --schema /app/database/schema.prisma
docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm db:seed
docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm admin:create
docker compose --env-file .env.production -f compose.production.yaml up -d
```

La base de producción empieza vacía. El seed es para la primera instalación; no ejecutarlo en actualizaciones porque puede sobrescribir el catálogo. No transfiere usuarios/datos del Mac: para conservarlos se necesita exportar/restaurar PostgreSQL antes de abrir la web. Caddy solicita y renueva HTTPS cuando el DNS apunta al servidor.

## Actualizaciones

1. Copia de seguridad de PostgreSQL (ver abajo) antes de cualquier cambio.
2. Copiar el proyecto con `rsync`, excluyendo `.env*`, `node_modules`, `.pnpm-store`, `.git`, `dist`, `storage/media` y `.agent-runner`.
3. Construir, aplicar migraciones pendientes y arrancar:

```sh
docker compose --env-file .env.production -f compose.production.yaml build api web
docker compose --env-file .env.production -f compose.production.yaml run --rm api pnpm exec prisma migrate deploy --schema /app/database/schema.prisma
docker compose --env-file .env.production -f compose.production.yaml up -d
```

La imagen normaliza permisos de lectura (`chmod -R a+rX /app`): un archivo con permisos 600 en el Mac dejaba la API en reinicio continuo (`EACCES` al leer `package.json`, Caddy respondía 502).

## Copias de seguridad

Antes de actualizar y diariamente, exportar PostgreSQL:

```sh
docker compose --env-file .env.production -f compose.production.yaml exec -T db pg_dump -U instafix -Fc instafix > instafix-backup.dump
```

Guardar las copias cifradas fuera del VPS, en un bucket privado diferente del multimedia público. Configurar retención y comprobar restauración antes del lanzamiento. Las snapshots del VPS son complementarias. Este repositorio prepara el despliegue; la contratación, DNS, credenciales, programación de backups y verificación remota requieren acceso a las cuentas del propietario.
