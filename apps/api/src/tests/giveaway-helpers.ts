import { db } from '../database/client';

/** Cierra los sorteos abiertos de la base de pruebas: cada prueba crea el suyo. */
export async function closeOpenGiveaways() {
  await db.giveaway.updateMany({ where: { closedAt: null }, data: { closedAt: new Date() } });
}
