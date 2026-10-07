import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export const directory = () => resolve(process.env.MEDIA_DIR || '../../storage/media');
// Las claves son generadas por el servidor; nunca se usa el nombre del archivo del usuario.
export async function store(path: string, key: string, contentType: string) {
  if ((process.env.MEDIA_STORAGE || 'local') === 'local') {
    await mkdir(directory(), { recursive: true });
    await copyFile(path, join(directory(), key));
    return `/api/v1/media/${key}`;
  }
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } =
    process.env;
  if (
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET ||
    !R2_PUBLIC_URL?.startsWith('https://')
  )
    throw new ServiceUnavailableException('Completa la configuración de R2 en el servidor.');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: await readFile(path),
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  } catch {
    throw new ServiceUnavailableException(
      'No pudimos guardar el archivo en R2. Revisa las credenciales, los permisos y la conexión del servidor.',
    );
  } finally {
    client.destroy();
  }
  return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}
