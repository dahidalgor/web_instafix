import type { Prisma } from '@prisma/client';

/** Servicios publicados: activos y de un equipo activo (los antiguos sin equipo también). */
export const publishedOffering: Prisma.OfferingWhereInput = {
  active: true,
  OR: [{ equipmentId: null }, { equipment: { active: true } }],
};
