import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import type { Appointment } from '@prisma/client';
import { db } from '../database/client';
import { messageVariables, type MessageKind } from '../whatsapp/messages';
import { queueReminders } from '../whatsapp/queue';
import { processJob } from '../whatsapp/worker';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
/** Hora local de Ecuador (UTC−5) → instante. */
const ec = (isoLocal: string) => new Date(`${isoLocal}-05:00`);
// Visita: sábado 31 de octubre de 2026 a las 10:00 en Ecuador.
const VISIT = ec('2026-10-31T10:00:00');

const sent: { kind: MessageKind; cuando: string | undefined }[] = [];
const providers = {
  send: async (appointment: Appointment, kind: MessageKind) => {
    sent.push({ kind, cuando: messageVariables(kind, appointment).cuando });
    return { providerMessageId: `reminder-${randomInt(1e9)}`, provider: 'BIRD' };
  },
  confirm: async () => {},
};

async function confirmedVisit() {
  return db.appointment.create({
    data: {
      title: 'Mantenimiento',
      device: 'Laptop',
      startsAt: VISIT,
      endsAt: new Date(VISIT.getTime() + 3600000),
      address: 'Quito',
      technician: 'Técnico',
      contactName: 'Paul Prueba',
      contactPhone: `+59399${randomInt(1000000, 9999999)}`,
      whatsappConsentAt: ec('2026-10-20T09:00:00'),
      status: 'CONFIRMED',
      source: 'INSTAFIX_API',
    },
  });
}
const jobsOf = (appointmentId: string) =>
  db.automationJob.findMany({ where: { appointmentId }, orderBy: { createdAt: 'asc' } });

test(
  'recordatorio: solo el día anterior, nunca «mañana» el mismo día de la visita',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, { WHATSAPP_ENABLED: 'true', WHATSAPP_SENDING_ENABLED: 'true' });
    const ids: string[] = [];
    t.after(async () => {
      process.env = saved;
      await db.automationJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
    });

    // 1) Confirmada con días de antelación: un solo recordatorio, el día anterior a las 08:00.
    const early = await confirmedVisit();
    ids.push(early.id);
    await db.$transaction((tx) => queueReminders(tx, early, ec('2026-10-27T15:00:00')));
    const [reminder, ...others] = await jobsOf(early.id);
    assert.equal(others.length, 0, 'no hay recordatorio del mismo día');
    assert.equal(reminder.kind, 'DAY_BEFORE');
    assert.equal(reminder.dueAt.toISOString(), ec('2026-10-30T08:00:00').toISOString());
    assert.equal(reminder.expiresAt.toISOString(), ec('2026-10-31T00:00:00').toISOString());
    // Sale el día anterior y dice «mañana».
    sent.length = 0;
    await processJob(reminder.id, providers, ec('2026-10-30T08:00:30'));
    assert.deepEqual(sent, [{ kind: 'DAY_BEFORE', cuando: 'mañana' }]);

    // 2) Confirmada el día anterior por la tarde: sale enseguida (sigue siendo el día anterior).
    const late = await confirmedVisit();
    ids.push(late.id);
    const confirmedAt = ec('2026-10-30T18:00:00');
    await db.$transaction((tx) => queueReminders(tx, late, confirmedAt));
    const [lateReminder] = await jobsOf(late.id);
    assert.equal(lateReminder.kind, 'DAY_BEFORE');
    assert.equal(lateReminder.dueAt.toISOString(), confirmedAt.toISOString());

    // 3) Confirmada el mismo día de la visita: ningún recordatorio.
    const sameDay = await confirmedVisit();
    ids.push(sameDay.id);
    await db.$transaction((tx) => queueReminders(tx, sameDay, ec('2026-10-31T07:30:00')));
    assert.equal((await jobsOf(sameDay.id)).length, 0);

    // 4) Recordatorio del día anterior que no salió a tiempo (worker caído, reintento):
    //    a las 08:00 del día de la visita se cancela sin enviar.
    sent.length = 0;
    await processJob(lateReminder.id, providers, ec('2026-10-31T08:00:00'));
    assert.equal(sent.length, 0);
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: lateReminder.id } })).status,
      'CANCELLED',
    );

    // 5) Filas antiguas ya encoladas en producción:
    //    - SAME_DAY (el que mandó «mañana» el mismo día) → se cancela sin enviar.
    //    - DAY_BEFORE con una caducidad mal guardada (la hora de la visita) → igual se cancela
    //      el día de la visita.
    const legacy = await confirmedVisit();
    ids.push(legacy.id);
    const legacyJob = (kind: string, expiresAt: Date) =>
      db.automationJob.create({
        data: {
          dedupeKey: `${legacy.id}:0:${kind}`,
          appointmentId: legacy.id,
          revision: legacy.automationRevision,
          kind,
          dueAt: ec('2026-10-31T08:00:00'),
          expiresAt,
          recipient: legacy.contactPhone,
        },
      });
    const oldSameDay = await legacyJob('SAME_DAY', VISIT);
    const oldDayBefore = await legacyJob('DAY_BEFORE', VISIT);
    sent.length = 0;
    for (const job of [oldSameDay, oldDayBefore])
      await processJob(job.id, providers, ec('2026-10-31T08:00:00'));
    assert.equal(sent.length, 0, 'nada se envía el día de la visita');
    const statuses = (await jobsOf(legacy.id)).map((j) => j.status);
    assert.deepEqual(statuses, ['CANCELLED', 'CANCELLED']);
  },
);
