import { registrationSchema } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../auth/security';
config({ path: '../../.env' });
const db = new PrismaClient();
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = await rl.question('Nombre del administrador: ');
  const phone = normalizePhone(await rl.question('Teléfono internacional: '), 'EC');
  rl.close();
  if (!process.stdin.isTTY) throw new Error('Ejecuta este comando en una terminal interactiva');
  process.stdout.write('Contraseña (mínimo 12 caracteres, entrada oculta): ');
  const password = await new Promise<string>((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', handler);
      process.stdout.write('\n');
    };
    const handler = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelado'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', handler);
  });
  const parsed = registrationSchema.parse({ name, phone, password });
  if (await db.user.findUnique({ where: { phone: parsed.phone } }))
    throw new Error('Este teléfono ya tiene cuenta. No se elevarán permisos automáticamente.');
  await db.user.create({
    data: {
      name: parsed.name,
      phone: parsed.phone,
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });
  console.log('Administrador creado. Abre http://admin.localhost:5173');
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
