import type { StaffNotificationType } from '@instafix/contracts';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';
import { enqueueStaffMessage } from '../notifications/staff/staff-notifications';
import { lockAppointment } from './queue';

/**
 * Número mal escrito o sin WhatsApp. Meta responde «Message Undeliverable» (131026) cuando el
 * teléfono no existe o no tiene WhatsApp: el cliente nunca recibirá los avisos ni podrá enviar
 * la ubicación. Entonces:
 *  - la cita queda marcada para que el equipo llame o corrija el número,
 *  - se detiene el plazo del cliente para enviar la ubicación (no se cancela por algo que no
 *    pudo recibir; solo vence si ningún técnico la confirma),
 *  - administración recibe un aviso en el panel.
 * Al corregir el teléfono desde el panel la marca se quita y la solicitud se envía de nuevo.
 */
export const UNDELIVERABLE_ISSUE =
  'WhatsApp no pudo entregar los mensajes a este número: puede estar mal escrito o no tener WhatsApp. Llama al cliente o corrige el teléfono en la cita (al guardarlo se le escribe de nuevo).';
const UNDELIVERABLE_META_CODES = ['131026'];
const LOOKBACK_MS = 2 * 86400000;

/** ¿El error guardado del envío dice que el número no puede recibir WhatsApp? */
export const isUndeliverable = (lastError: string | null) =>
  !!lastError && UNDELIVERABLE_META_CODES.some((code) => lastError.includes(`Meta ${code}`));

/** Cada minuto (worker): marca las citas activas cuyo número no recibe WhatsApp. */
export async function flagUndeliverableNumbers(now = new Date()) {
  const failed = await db.automationJob.findMany({
    where: {
      deliveryStatus: 'FAILED',
      createdAt: { gt: new Date(now.getTime() - LOOKBACK_MS) },
      OR: UNDELIVERABLE_META_CODES.map((code) => ({ lastError: { contains: `Meta ${code}` } })),
      appointment: {
        deletedAt: null,
        status: { in: ['PENDING_LOCATION', 'CONFIRMED'] },
        endsAt: { gt: now },
        OR: [{ automationIssue: null }, { automationIssue: { not: UNDELIVERABLE_ISSUE } }],
      },
    },
    select: { appointmentId: true, revision: true, recipient: true },
    take: 20,
  });
  const flagged: string[] = [];
  for (const job of failed) {
    if (flagged.includes(job.appointmentId)) continue;
    const done = await db.$transaction(async (tx) => {
      await lockAppointment(tx, job.appointmentId);
      const a = await tx.appointment.findUniqueOrThrow({ where: { id: job.appointmentId } });
      // Solo si el número sigue siendo el mismo al que se escribió (no se corrigió ya).
      if (
        a.deletedAt ||
        a.automationIssue === UNDELIVERABLE_ISSUE ||
        job.revision !== a.automationRevision ||
        (job.recipient && job.recipient !== a.contactPhone)
      )
        return false;
      const updated = await tx.appointment.update({
        where: { id: a.id },
        data: {
          automationIssue: UNDELIVERABLE_ISSUE,
          // El cliente no recibió la solicitud de ubicación: su plazo no corre.
          ...(a.status === 'PENDING_LOCATION' && !a.locationReceivedAt
            ? { responseDueAt: null }
            : {}),
        },
      });
      // La advertencia «envía la ubicación o se cancela» tampoco le llegaría.
      await tx.automationJob.updateMany({
        where: {
          appointmentId: a.id,
          kind: 'LOCATION_REMINDER',
          status: { in: ['PENDING', 'RETRY'] },
        },
        data: { status: 'CANCELLED' },
      });
      const type: StaffNotificationType = 'WHATSAPP_UNDELIVERABLE';
      const admins = await tx.user.findMany({
        where: { role: 'ADMIN', active: true, deletedAt: null },
        select: { id: true },
      });
      for (const admin of admins)
        await enqueueStaffMessage(
          tx,
          type,
          updated,
          admin.id,
          {
            title: 'Número sin WhatsApp',
            body: `No pudimos escribirle a ${updated.contactName || 'el cliente'} por WhatsApp: revisa su número y llámalo o corrígelo en la cita.`,
          },
          `${updated.automationRevision}`,
          now,
        );
      return true;
    });
    if (done) {
      flagged.push(job.appointmentId);
      logEvent('whatsapp.undeliverable', { appointmentId: job.appointmentId }, 'warn');
    }
  }
  return flagged;
}
