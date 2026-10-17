#!/usr/bin/env node
// Ejecutor local para sesiones asistidas. Solo lo inicia una persona desde su Terminal:
//   node scripts/agent-runner.mjs
// Ejecuta, uno por uno, los scripts que aparezcan en .agent-runner/queue/ dentro de este
// proyecto y guarda la salida en .agent-runner/out/. Detener con Ctrl+C.
// Un script cuya primera línea sea "# background" queda en segundo plano (p. ej. pnpm dev);
// se detiene creando .agent-runner/queue/<id>.stop.
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, '.agent-runner');
const queue = join(base, 'queue');
const out = join(base, 'out');
const done = join(base, 'done');
for (const dir of [queue, out, done]) mkdirSync(dir, { recursive: true });
const TIMEOUT_MS = 20 * 60 * 1000;
const background = new Map();
let busy = false;

function log(message) {
  console.log(`[agent-runner ${new Date().toLocaleTimeString()}] ${message}`);
}

function run(id, file) {
  const script = readFileSync(file, 'utf8');
  const isBackground = script.startsWith('# background');
  renameSync(file, join(done, `${id}.sh`));
  const output = createWriteStream(join(out, `${id}.log`));
  log(`${isBackground ? 'iniciando en segundo plano' : 'ejecutando'} ${id}`);
  const child = spawn('/bin/zsh', ['-lc', script], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    detached: isBackground,
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  writeFileSync(join(out, `${id}.pid`), String(child.pid));
  const finish = (code) => {
    output.end();
    writeFileSync(join(out, `${id}.exit`), String(code));
    log(`${id} terminó con código ${code}`);
  };
  if (isBackground) {
    background.set(id, child);
    child.on('exit', (code) => {
      background.delete(id);
      finish(code ?? 'signal');
    });
    return Promise.resolve();
  }
  return new Promise((resolveRun) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? 'timeout');
      resolveRun();
    });
  });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const files = readdirSync(queue).sort();
    for (const name of files) {
      const path = join(queue, name);
      if (name.endsWith('.stop')) {
        const id = name.slice(0, -5);
        const child = background.get(id);
        if (child) process.kill(-child.pid, 'SIGTERM');
        rmSync(path, { force: true });
        log(`detenido ${id}`);
      } else if (name.endsWith('.sh') && existsSync(path)) {
        await run(name.slice(0, -3), path);
      }
    }
  } catch (error) {
    log(`error: ${error.message}`);
  } finally {
    busy = false;
  }
}

function stopAll() {
  for (const child of background.values()) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
writeFileSync(join(base, 'runner.alive'), String(process.pid));
log(`listo en ${root}. Ctrl+C para detener.`);
setInterval(() => {
  writeFileSync(join(base, 'runner.alive'), `${process.pid} ${Date.now()}`);
  tick();
}, 1000);
