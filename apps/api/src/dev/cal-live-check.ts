// Comprobación CONTROLADA contra la cuenta real de Cal.com. Crea UNA reserva de prueba
// en un horario lejano, la consulta, la reprograma y la cancela. Cal.com puede enviar
// correos por ella. Requiere el flag explícito --confirm-real-booking.
//   pnpm --filter @instafix/api exec tsx src/dev/cal-live-check.ts --confirm-real-booking \
//     --email tu-correo@ejemplo.com --phone +5939XXXXXXXX
import '../config/environment';
import { randomUUID } from 'node:crypto';
import {
  cancelCalBooking,
  createCalBooking,
  findCalBookingForAppointment,
  getCalBooking,
  getCalSlots,
  localDate,
  rescheduleCalBooking,
} from '../integrations/cal-api';

const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
const timeZone = 'America/Guayaquil';

async function main() {
  if (!args.includes('--confirm-real-booking')) {
    console.log(
      'Solo consulta disponibilidad. Usa --confirm-real-booking para crear la reserva de prueba.',
    );
  }
  const from = localDate(new Date(Date.now() + 21 * 86400000), timeZone);
  const to = localDate(new Date(Date.now() + 35 * 86400000), timeZone);
  const days = await getCalSlots({ startDate: from, endDate: to, timeZone });
  const dates = Object.keys(days).sort();
  console.log(`slots: ${dates.length} días con horarios entre ${from} y ${to}`);
  for (const day of dates.slice(0, 3))
    console.log(
      `  ${day}: ${days[day].map((s) => new Date(s.start).toLocaleTimeString('es-EC', { timeZone, hour: '2-digit', minute: '2-digit' })).join(' ')}`,
    );
  if (!args.includes('--confirm-real-booking') || !dates.length) return;

  // Último horario del último día disponible: el menos probable de interferir con clientes.
  const lastDay = days[dates.at(-1)!];
  const slot = lastDay.at(-1)!;
  const id = randomUUID();
  const booking = await createCalBooking({
    start: slot.start,
    attendee: {
      name: 'PRUEBA InstaFix (no atender)',
      email: arg('--email'),
      phoneNumber: arg('--phone'),
      timeZone,
    },
    bookingFieldsResponses: { notes: 'PRUEBA DE INTEGRACIÓN API — se cancelará automáticamente.' },
    metadata: { instafixAppointmentId: id, instafixSource: 'live-check' },
  });
  console.log(`creada: status=${booking.status} start=${booking.start} end=${booking.end}`);
  try {
    const fetched = await getCalBooking(booking.uid);
    console.log(
      `consultada: status=${fetched.status} metadata=${JSON.stringify(fetched.metadata)}`,
    );
    const found = await findCalBookingForAppointment({
      appointmentId: id,
      start: new Date(booking.start),
      attendeeEmail: arg('--email'),
    });
    console.log(
      `conciliación por metadata: ${found?.uid === booking.uid ? 'OK' : 'NO ENCONTRADA'}`,
    );
    const after = await getCalSlots({ startDate: dates.at(-1)!, endDate: dates.at(-1)!, timeZone });
    console.log(
      `el horario dejó de estar libre: ${!(after[dates.at(-1)!] ?? []).some((s) => s.start === slot.start)}`,
    );
    const other = (after[dates.at(-1)!] ?? [])[0] ?? days[dates.at(-2)!]?.at(-1);
    if (other) {
      const moved = await rescheduleCalBooking(
        booking.uid,
        other.start,
        'Prueba de reprogramación',
      );
      console.log(
        `reprogramada: nuevo uid distinto=${moved.uid !== booking.uid} status=${moved.status} start=${moved.start}`,
      );
      booking.uid = moved.uid;
    }
  } finally {
    await cancelCalBooking(booking.uid, 'Prueba de integración finalizada');
    const final = await getCalBooking(booking.uid);
    console.log(`cancelada: status=${final.status}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : 'desconocido'}`);
  process.exit(1);
});
