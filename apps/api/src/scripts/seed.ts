import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
config({ path: '../../.env' });
const db = new PrismaClient();
async function main() {
  const equipment = await db.equipment.upsert({
    where: { name: 'PS5' },
    create: { name: 'PS5', category: 'Consolas' },
    update: {},
  });
  const services = [
    {
      id: 'ps5-basic',
      title: 'Mantenimiento básico',
      priceMinor: 2500,
      description:
        'Servicio de mantenimiento básico para PS5. Consulta con Instafix las tareas incluidas y el estado de tu equipo antes de reservar.',
    },
    {
      id: 'ps5-complete',
      title: 'Mantenimiento completo',
      priceMinor: 6000,
      description:
        'Servicio de mantenimiento completo para PS5. El técnico te indicará el alcance y las condiciones según el estado de la consola.',
    },
    {
      id: 'ps5-joystick',
      title: 'Cambio de Joystick',
      priceMinor: 1800,
      description:
        'Cambio de un joystick para el control de PS5. Confirma la compatibilidad y el diagnóstico con el técnico.',
    },
    {
      id: 'ps5-pair',
      title: 'Par de joysticks',
      priceMinor: 6000,
      description:
        'Servicio para un par de joysticks del control de PS5. Consulta el tipo de repuesto y el alcance con Instafix.',
    },
  ];
  for (const service of services)
    await db.offering.upsert({
      where: { id: service.id },
      create: {
        ...service,
        device: 'PS5',
        category: 'Consolas',
        equipmentId: equipment.id,
        durationMinutes: 60,
        availability: 'AVAILABLE',
      },
      update: {},
    });
  // Retire only the known illustrative records; preserve their request history.
  await db.offering.updateMany({
    where: { id: { in: ['ps4-maintenance', 'ps5-maintenance', 'laptop-diagnosis'] } },
    data: { active: false, availability: 'UNAVAILABLE' },
  });
  await db.sitePolicy.upsert({
    where: { id: 'warranty' },
    create: {
      id: 'warranty',
      text: 'Las condiciones y el plazo de garantía se informan para cada servicio antes de contratarlo. Consulta con Instafix qué incluye la cobertura. Cuando un trabajo tenga garantía registrada, encontrarás su fecha de vencimiento y condiciones en Mi cuenta.',
    },
    update: {},
  });
}
main()
  .catch(() => {
    console.error('No se pudo cargar el catálogo. Revisa PostgreSQL y DATABASE_URL.');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
