import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { store } from './media-storage';
const execute = promisify(execFile);
// Una conversión por proceso limita el uso de memoria y CPU del VPS.
let processing = false;
export async function processUpload(req: Request) {
  if (processing)
    throw new ServiceUnavailableException(
      'Hay otro archivo procesándose. Inténtalo en unos momentos.',
    );
  const kind = req.headers['x-media-type'];
  if (
    !['image', 'video'].includes(String(kind)) ||
    req.headers['content-type'] !== 'application/octet-stream'
  )
    throw new BadRequestException('Selecciona una imagen o un video.');
  const limit = (kind === 'image' ? 20 : 100) * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit)
    throw new BadRequestException('El archivo supera el límite permitido.');
  processing = true;
  let temp: string | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), 'instafix-media-'));
    const input = join(temp, 'input');
    let bytes = 0;
    await pipeline(
      req,
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > limit ? new Error('Archivo demasiado grande') : null, chunk);
        },
      }),
      createWriteStream(input),
      { signal: AbortSignal.timeout(120000) },
    );
    const id = randomUUID();
    if (kind === 'image') {
      const output = join(temp, 'image.webp');
      const small = join(temp, 'small.webp');
      const metadata = await sharp(input, { limitInputPixels: 40000000 }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format || ''))
        throw new BadRequestException('Usa fotos JPG, PNG o WebP.');
      await sharp(input, { limitInputPixels: 40000000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(output);
      await sharp(output)
        .resize({ width: 640, withoutEnlargement: true })
        .webp({ quality: 76 })
        .toFile(small);
      return {
        type: 'image',
        url: await store(output, `${id}.webp`, 'image/webp'),
        thumbnail: await store(small, `${id}-small.webp`, 'image/webp'),
        alt: '',
      };
    }
    const handle = await open(input, 'r');
    const header = Buffer.alloc(12);
    try {
      await handle.read(header, 0, 12, 0);
    } finally {
      await handle.close();
    }
    if (header.toString('ascii', 4, 8) !== 'ftyp' && header.readUInt32BE(0) !== 0x1a45dfa3)
      throw new BadRequestException('Usa videos MP4, MOV o WebM.');
    const { stdout } = await execute(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        input,
      ],
      { timeout: 15000 },
    );
    const info = JSON.parse(stdout);
    const duration = Number(info.format?.duration);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 60 ||
      !info.streams?.some((s: any) => s.codec_type === 'video')
    )
      throw new BadRequestException('Selecciona un video de hasta 60 segundos.');
    const output = join(temp, 'video.mp4');
    const poster = join(temp, 'poster.webp');
    await execute(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-t',
        '60',
        '-vf',
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '26',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '2',
        '-an',
        '-movflags',
        '+faststart',
        output,
      ],
      { timeout: 180000 },
    );
    const posterPng = join(temp, 'poster.png');
    await execute(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-nostdin', '-v', 'error', '-i', output, '-frames:v', '1', posterPng],
      { timeout: 15000 },
    );
    await sharp(posterPng).webp({ quality: 76 }).toFile(poster);
    return {
      type: 'video',
      url: await store(output, `${id}.mp4`, 'video/mp4'),
      poster: await store(poster, `${id}-poster.webp`, 'image/webp'),
      alt: '',
    };
  } catch (error: any) {
    if (error instanceof BadRequestException || error instanceof ServiceUnavailableException)
      throw error;
    if (error.code === 'ENOENT')
      throw new ServiceUnavailableException(
        'El procesador de video no está instalado en el servidor.',
      );
    throw new BadRequestException(
      'No pudimos procesar el archivo. Usa JPG, PNG, WebP o un video MP4, MOV o WebM de hasta 60 segundos.',
    );
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    processing = false;
  }
}
