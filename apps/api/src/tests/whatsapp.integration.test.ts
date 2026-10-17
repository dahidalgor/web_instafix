import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { receiveCustomerMessage } from '../whatsapp/inbound';
import { processJob } from '../whatsapp/worker';
import { ProviderError } from '../integrations/provider-error';
import { receiveDelivery } from '../whatsapp/delivery';

test(
  'persistent booking → location → Cal confirmation → reminders; deduplication and cancellation',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const prefix = `wa-test-${randomUUID()}`;
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_EVENT_TYPE_ID: '987654321',
      WHATSAPP_ENABLED: 'false',
    });
    const phone = '+593999123456';
    const start = new Date(Date.now() + 4 * 86400000);
    start.setUTCHours(16, 0, 0, 0);
    let eventTime = Date.now() - 60000;
    const event = (uid: string, triggerEvent = 'BOOKING_REQUESTED', extra = {}) => ({
      triggerEvent,
      createdAt: new Date((eventTime += 1000)).toISOString(),
      payload: {
        uid,
        eventTypeId: 987654321,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3600000).toISOString(),
        attendees: [{ name: 'Cliente de prueba', phoneNumber: phone }],
        responses: { servicio: { value: 'Mantenimiento PS5' }, whatsappConsent: { value: true } },
        ...extra,
      },
    });
    const location = (id: string, context?: string, from = phone.slice(1)) => ({
      id: `${prefix}:${id}`,
      from,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'location',
      location: { latitude: -0.2, longitude: -78.5 },
      ...(context ? { context: { id: context } } : {}),
    });
    const appointment = (uid: string) =>
      db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    let sends = 0,
      confirms = 0;
    const providers = {
      send: async () => `${prefix}:provider:${++sends}`,
      confirm: async () => {
        confirms++;
      },
    };
    t.after(async () => {
      await db.appointment.deleteMany({ where: { calUid: { startsWith: prefix } } });
      await db.integrationEvent.deleteMany({
        where: {
          OR: [{ sourceId: { startsWith: prefix } }, { id: { startsWith: `wa:${prefix}` } }],
        },
      });
      process.env = saved;
      await db.$disconnect();
    });
    const first = `${prefix}:first`;
    const requested = event(first);
    await receiveCalWebhook(requested);
    await receiveCalWebhook(requested);
    const a = await appointment(first);
    assert.equal(a.userId, null);
    assert.equal(a.status, 'PENDING_LOCATION');
    const initial = await db.automationJob.findFirstOrThrow({ where: { appointmentId: a.id } });
    assert.equal(await db.automationJob.count({ where: { appointmentId: a.id } }), 1);
    await receiveDelivery({
      id: `${prefix}:provider:1`,
      status: 'read',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    await Promise.all([processJob(initial.id, providers), processJob(initial.id, providers)]);
    assert.equal(sends, 1);
    await receiveDelivery({
      id: `${prefix}:provider:1`,
      status: 'sent',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: initial.id } })).deliveryStatus,
      'read',
    );
    await receiveCustomerMessage(location('wrong-phone', undefined, '593987654321'));
    assert.equal((await appointment(first)).locationReceivedAt, null);
    await receiveCustomerMessage(location('first'));
    await receiveCustomerMessage(location('first'));
    assert.equal((await appointment(first)).status, 'PENDING_LOCATION');
    const confirmJob = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: a.id, kind: 'CAL_CONFIRM' },
    });
    await processJob(confirmJob.id, {
      ...providers,
      confirm: async () => {
        throw new ProviderError('Cal no responde', 'RETRY');
      },
    });
    assert.equal((await appointment(first)).status, 'PENDING_LOCATION');
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: a.id, kind: 'CONFIRMED' } }),
      0,
    );
    await processJob(confirmJob.id, providers, new Date(Date.now() + 300000));
    assert.equal(confirms, 1);
    assert.equal((await appointment(first)).status, 'CONFIRMED');
    const jobs = await db.automationJob.findMany({ where: { appointmentId: a.id } });
    assert.deepEqual(
      jobs.map((j) => j.kind).sort(),
      ['INITIAL', 'CAL_CONFIRM', 'CONFIRMED', 'DAY_BEFORE', 'SAME_DAY'].sort(),
    );
    for (const kind of ['DAY_BEFORE', 'SAME_DAY'])
      assert.equal(jobs.find((j) => j.kind === kind)?.dueAt.getUTCHours(), 13);
    await receiveCalWebhook(event(first, 'BOOKING_CREATED', { status: 'ACCEPTED' }));
    assert.equal((await appointment(first)).status, 'CONFIRMED');
    assert.equal(await db.automationJob.count({ where: { appointmentId: a.id } }), 5);
    await receiveCalWebhook(event(first, 'BOOKING_CANCELLED'));
    await receiveCalWebhook(event(first));
    assert.equal((await appointment(first)).status, 'CANCELLED');
    for (const j of jobs.filter((j) => ['DAY_BEFORE', 'SAME_DAY'].includes(j.kind)))
      await processJob(j.id, providers, j.dueAt);
    assert.equal(sends, 1);

    const second = `${prefix}:second`,
      third = `${prefix}:third`;
    await receiveCalWebhook(event(second));
    await receiveCalWebhook(event(third));
    await receiveCustomerMessage(location('ambiguous'));
    assert.equal((await appointment(second)).locationReceivedAt, null);
    assert.match((await appointment(third)).automationIssue || '', /Varias citas/);
    const secondJob = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: (await appointment(second)).id, kind: 'INITIAL' },
    });
    await processJob(secondJob.id, providers);
    const providerId = (await db.automationJob.findUniqueOrThrow({ where: { id: secondJob.id } }))
      .providerId!;
    await receiveCustomerMessage(location('context', providerId));
    assert.ok((await appointment(second)).locationReceivedAt);
    assert.equal((await appointment(third)).locationReceivedAt, null);
    const fourth = `${prefix}:fourth`;
    await receiveCalWebhook(event(fourth, 'BOOKING_RESCHEDULED', { rescheduleUid: third }));
    assert.equal((await appointment(third)).status, 'RESCHEDULED');
    assert.equal((await appointment(fourth)).status, 'PENDING_LOCATION');
    const fourthJob = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: (await appointment(fourth)).id },
    });
    await processJob(fourthJob.id, {
      ...providers,
      send: async () => {
        throw new ProviderError('Envío incierto', 'REVIEW');
      },
    });
    await processJob(fourthJob.id, providers, new Date(Date.now() + 600000));
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: fourthJob.id } })).status,
      'REVIEW',
    );
    const noConsent = `${prefix}:no-consent`;
    await receiveCalWebhook(
      event(noConsent, 'BOOKING_REQUESTED', { responses: { servicio: { value: 'PS5' } } }),
    );
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: (await appointment(noConsent)).id } }),
      0,
    );
  },
);
