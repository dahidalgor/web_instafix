import { offeringSchema } from '@instafix/contracts';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { newToken, tokenHash } from '../auth/security';
config({ path: '../../.env' });
test(
  'media uploads require admin; images and videos are converted, served and validated',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const db = new PrismaClient();
    const users: string[] = [];
    const files: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'instafix-media-test-'));
    const base = process.env.INSTAFIX_TEST_API || 'http://127.0.0.1:3001';
    async function upload(
      token: string,
      body: Buffer,
      kind = 'image',
      origin = 'http://localhost:5173',
    ) {
      return fetch(`${base}/api/v1/admin/media`, {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `instafix_session=${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Media-Type': kind,
        },
        body: new Uint8Array(body),
      });
    }
    try {
      const tokens: string[] = [];
      for (const role of ['CUSTOMER', 'ADMIN'] as const) {
        const user = await db.user.create({
          data: {
            name: 'Temporary media test',
            phone: `test-${randomUUID()}`,
            passwordHash: 'test-no-login',
            role,
          },
        });
        users.push(user.id);
        const token = newToken();
        tokens.push(token);
        await db.session.create({
          data: {
            userId: user.id,
            tokenHash: tokenHash(token),
            expiresAt: new Date(Date.now() + 120000),
          },
        });
      }
      const image = await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: '#701455' },
      })
        .png()
        .toBuffer();
      assert.equal((await upload('', image)).status, 401);
      assert.equal((await upload(tokens[0], image)).status, 403);
      assert.equal(
        (await upload(tokens[1], image, 'image', 'https://invalid.example')).status,
        403,
      );
      assert.equal((await upload(tokens[1], Buffer.from('not an image'))).status, 400);
      const result = await upload(tokens[1], image);
      const media = await result.json();
      assert.equal(result.status, 201, JSON.stringify(media));
      files.push(media.url, media.thumbnail);
      const photo = await fetch(base + media.url);
      assert.equal(photo.status, 200);
      const info = await sharp(Buffer.from(await photo.arrayBuffer())).metadata();
      assert.equal(info.format, 'webp');
      assert.equal(info.width, 1600);
      const videoFile = join(dir, 'test.mp4');
      await promisify(execFile)('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=purple:s=320x240:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        videoFile,
      ]);
      const videoResult = await upload(tokens[1], await readFile(videoFile), 'video');
      const video = await videoResult.json();
      assert.equal(videoResult.status, 201, JSON.stringify(video));
      files.push(video.url, video.poster);
      const range = await fetch(base + video.url, { headers: { Range: 'bytes=0-31' } });
      assert.equal(range.status, 206);
      assert.equal((await fetch(base + video.poster)).status, 200);
      const parsed = offeringSchema.safeParse({
        equipmentId: 'test',
        title: 'Example',
        description: 'Long description of example',
        priceMinor: 100,
        durationMinutes: 60,
        warrantyDays: 0,
        availability: 'AVAILABLE',
        media: [media, video],
      });
      assert.equal(parsed.success, true);
    } finally {
      for (const path of files)
        if (path.startsWith('/api/v1/media/'))
          await rm(join(resolve(process.env.MEDIA_DIR || '../../storage/media'), basename(path)), {
            force: true,
          });
      await rm(dir, { recursive: true, force: true });
      await db.session.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  },
);
