import { calHealth } from '../integrations/cal-health';

/** Revisión de la agenda desde la terminal (sin datos de clientes ni claves en la salida). */
async function main() {
  const health = await calHealth();
  console.log(JSON.stringify(health, null, 2));
  process.exitCode = health.ok ? 0 : 1;
}
void main();
