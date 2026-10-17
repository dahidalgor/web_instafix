import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { db } from '../database/client';
import { tokenHash, newToken } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { BookingAdminController } from '../booking/booking-admin.controller';
import { AccountController } from '../account/account.controller';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { receiveCustomerMessage } from '../whatsapp/inbound';
import { processJob } from '../whatsapp/worker';

test(
  'new/existing bookings retain ownership; mismatches cannot send or confirm; old links recover safely',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const userIds: string[] = [],
      appointmentIds: string[] = [],
      uids: string[] = [];
    const originalEventType = process.env.CAL_EVENT_TYPE_ID;
    process.env.CAL_EVENT_TYPE_ID = '991992';
    const marker = randomUUID();
    const waId = `identity-${marker}`;
    const account = new AccountController(),
      booking = new BookingController(),
      adminLinks = new BookingAdminController();
    const req = (token = '') =>
      ({
        headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
      }) as Request;
    let ordinal = 0;
    try {
      const requests: Request[] = [];
      for (const role of ['CUSTOMER', 'CUSTOMER', 'ADMIN'] as const) {
        const user = await db.user.create({
          data: {
            name: 'Prueba de vinculación',
            phone: `test-${marker}-${ordinal++}`,
            email: `test-${randomUUID()}@example.com`,
            emailVerifiedAt: new Date(),
            passwordHash: 'no-login',
            phoneVerifiedAt: new Date(),
            role,
          },
        });
        userIds.push(user.id);
        const token = newToken();
        await db.session.create({
          data: {
            userId: user.id,
            tokenHash: tokenHash(token),
            expiresAt: new Date(Date.now() + 600000),
          },
        });
        requests.push(req(token));
      }
      // Números solo en fixtures: el worker real permanece apagado y los proveedores son mocks.
      await db.user.update({ where: { id: userIds[0] }, data: { phone: '+593990001111' } });
      const [customer, other, admin] = requests;
      const context = await booking.context(customer);
      const event = (reference?: string) => {
        const uid = `${marker}-${randomUUID()}`;
        uids.push(uid);
        return {
          triggerEvent: 'BOOKING_REQUESTED',
          createdAt: new Date().toISOString(),
          payload: {
            uid,
            eventTypeId: 991992,
            startTime: new Date(Date.now() + 86400000).toISOString(),
            endTime: new Date(Date.now() + 90000000).toISOString(),
            attendees: [{ name: context.user!.name, phoneNumber: context.user!.phone }],
            metadata: reference ? { instafixReference: reference } : {},
            responses: { servicio: { value: 'Revisar consola' }, whatsappConsent: { value: true } },
          },
        };
      };
      const original = event(context.token!);
      await receiveCalWebhook(original);
      let mine = await account.appointments(customer);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].userId, userIds[0]);
      assert.equal((await account.appointments(other)).length, 0);
      const id = mine[0].id;
      // Simula el bug antiguo: misma reserva sin usuario. Un evento sin cambios de campos debe repararla.
      await db.appointment.update({ where: { id }, data: { userId: null } });
      await receiveCalWebhook({
        ...original,
        triggerEvent: 'BOOKING_CREATED',
        createdAt: new Date(Date.now() + 1000).toISOString(),
      });
      assert.equal((await account.appointments(customer))[0].id, id);
      // Un evento posterior sin metadata tampoco desvincula la reserva.
      await receiveCalWebhook({
        ...original,
        triggerEvent: 'BOOKING_CREATED',
        createdAt: new Date(Date.now() + 2000).toISOString(),
        payload: { ...original.payload, metadata: {} },
      });
      assert.equal((await account.appointments(customer))[0].id, id);
      const rescheduled = event();
      await receiveCalWebhook({
        ...rescheduled,
        payload: { ...rescheduled.payload, rescheduleUid: original.payload.uid },
      });
      mine = await account.appointments(customer);
      assert.equal(mine.length, 2);
      assert.equal(mine.find((a) => a.id === id)?.status, 'CANCELLED');
      assert.equal(mine.find((a) => a.calUid === rescheduled.payload.uid)?.userId, userIds[0]);
      // Datos alterados: se conserva la cuenta, se usa su teléfono y no se inicia automatización.
      const alteredContext = await booking.context(customer);
      const altered = event(alteredContext.token!);
      altered.payload.attendees[0].phoneNumber = '+593990002222';
      await receiveCalWebhook(altered);
      const blocked = await db.appointment.findUniqueOrThrow({
        where: { calUid: altered.payload.uid },
      });
      assert.equal(blocked.userId, userIds[0]);
      assert.equal(blocked.contactPhone, context.user!.phone);
      assert.equal(blocked.bookingIdentityIssue, 'PHONE_MISMATCH');
      assert.equal(await db.automationJob.count({ where: { appointmentId: blocked.id } }), 0);
      // Incluso un trabajo pendiente antiguo no puede contactar el número alterado.
      const job = await db.automationJob.create({
        data: {
          dedupeKey: marker,
          appointmentId: blocked.id,
          revision: blocked.automationRevision,
          kind: 'INITIAL',
          dueAt: new Date(),
          expiresAt: blocked.startsAt,
        },
      });
      await processJob(job.id, {
        send: async () => {
          throw new Error('No debe enviar');
        },
        confirm: async () => {
          throw new Error('No debe confirmar');
        },
      });
      assert.equal(
        (await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).status,
        'CANCELLED',
      );
      // Resolver una ubicación no debe quitar la cuarentena de identidad.
      await receiveCustomerMessage({
        id: waId,
        from: '593990002222',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'location',
        location: { latitude: 0, longitude: 0 },
      });
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: blocked.id } })).locationReceivedAt,
        null,
      );
      // Recuperación de antiguas: solo contexto consumido y teléfono coincidente.
      await db.appointment.update({ where: { id }, data: { userId: null } });
      assert.equal((await adminLinks.candidates(admin)).recoverable, 1);
      await assert.rejects(adminLinks.recover(customer));
      assert.equal((await adminLinks.recover(admin)).recovered, 1);
      assert.equal((await adminLinks.recover(admin)).recovered, 0);
      const guest = await db.appointment.create({
        data: {
          contactName: 'Invitado',
          contactPhone: context.user!.phone,
          title: 'Cita histórica',
          device: 'PC',
          startsAt: new Date(0),
          endsAt: new Date(3600000),
          address: '',
          technician: '',
        },
      });
      appointmentIds.push(guest.id);
      assert.equal((await adminLinks.candidates(admin)).recoverable, 0);
      await assert.rejects(
        adminLinks.link(guest.id, { userId: userIds[0], identityVerified: true }, customer),
      );
      await assert.rejects(
        adminLinks.link(guest.id, { userId: userIds[0], identityVerified: false }, admin),
      );
      await adminLinks.link(guest.id, { userId: userIds[0], identityVerified: true }, admin);
      await assert.rejects(
        adminLinks.link(guest.id, { userId: userIds[1], identityVerified: true }, admin),
      );
      assert.ok((await account.appointments(customer)).some((a) => a.id === guest.id));
      assert.equal((await account.appointments(other)).length, 0);
    } finally {
      if (originalEventType === undefined) delete process.env.CAL_EVENT_TYPE_ID;
      else process.env.CAL_EVENT_TYPE_ID = originalEventType;
      const created = await db.appointment.findMany({
        where: { calUid: { in: uids } },
        select: { id: true },
      });
      appointmentIds.push(...created.map((a) => a.id));
      await db.integrationEvent.deleteMany({
        where: {
          OR: [
            { provider: 'CAL', sourceId: { in: uids } },
            { provider: 'ACCOUNT_LINK', sourceId: { in: appointmentIds } },
            { id: `wa:${waId}` },
          ],
        },
      });
      await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    }
  },
);
