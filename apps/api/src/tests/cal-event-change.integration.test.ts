import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

test(
  'cambio de evento en Cal.com: las citas del evento anterior siguen sincronizadas',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    process.env.CAL_EVENT_TYPE_ID = '555000002';
    process.env.CAL_PREVIOUS_EVENT_TYPE_IDS = ' 555000001 , ';
    const uid = `event-change-${randomUUID()}`;
    t.after(async () => {
      const row = await db.appointment.findUnique({ where: { calUid: uid } });
      if (row) {
        await db.notification.deleteMany({ where: { appointmentId: row.id } });
        await db.automationJob.deleteMany({ where: { appointmentId: row.id } });
        await db.appointment.delete({ where: { id: row.id } });
      }
      await db.integrationEvent.deleteMany({
        where: { sourceId: { startsWith: 'event-change-' } },
      });
      process.env = saved;
    });
    const start = new Date(Date.now() + 4 * 86400000);
    const payload = (eventTypeId: number, id = uid) => ({
      uid: id,
      eventTypeId,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 7200000).toISOString(),
      attendees: [
        { name: 'Cliente Evento Viejo', phoneNumber: `+59399${randomInt(1000000, 9999999)}` },
      ],
      responses: { notes: { value: 'Mantenimiento PS5' } },
    });
    const send = (triggerEvent: string, eventTypeId: number, id?: string) =>
      receiveCalWebhook({
        triggerEvent,
        createdAt: new Date().toISOString(),
        payload: payload(eventTypeId, id),
      });

    // Cita agendada antes del cambio, en el evento anterior.
    assert.deepEqual(await send('BOOKING_CREATED', 555000001), { ok: true });
    assert.ok(await db.appointment.findUnique({ where: { calUid: uid } }));
    // Cancelada después desde Cal.com: Instafix la cancela igual.
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await send('BOOKING_CANCELLED', 555000001), { ok: true });
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { calUid: uid } })).status,
      'CANCELLED',
    );
    // Un evento que no es de Instafix se ignora.
    assert.deepEqual(await send('BOOKING_CREATED', 999, `event-change-${randomUUID()}`), {
      ignored: true,
    });
  },
);
