// Flujo de reserva propio contra PostgreSQL local y el SIMULADOR de Cal.com (sin agenda real).
// INSTAFIX_INTEGRATION=1 INSTAFIX_TEST_DISABLE_THROTTLE=1 pnpm --filter @instafix/api exec \
//   tsx --test --test-concurrency=1 src/tests/booking.integration.test.ts
import 'reflect-metadata';
import '../config/environment';
import { NestFactory } from '@nestjs/core';
import { normalizePhone } from '@instafix/contracts/src/phone';
import assert from 'node:assert/strict';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AppModule } from '../app.module';
import { newToken, tokenHash } from '../auth/security';
import { clearAvailabilityCache } from '../booking/booking.service';
import { db } from '../database/client';
import { CalSimulator } from '../dev/cal-simulator';

const ORIGIN = 'http://localhost:5173';

function randomPhone() {
  for (;;) {
    const phone = normalizePhone(`09${randomInt(10000000, 99999999)}`, 'EC');
    if (phone) return phone;
  }
}

test(
  'native booking: identity, idempotency, race conditions, ownership and Cal sync',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const saved = { ...process.env };
    const simulator = await new CalSimulator({ initialStatus: 'accepted' }).start();
    Object.assign(process.env, {
      CAL_API_BASE_URL: simulator.url,
      CAL_API_KEY: simulator.options.apiKey,
      CAL_EVENT_TYPE_ID: String(simulator.options.eventTypeId),
      CAL_WEBHOOK_SECRET: 'booking-test-secret',
      WHATSAPP_ENABLED: 'false',
      BOOKING_MODE: 'native',
      INSTAFIX_TEST_DISABLE_THROTTLE: '1',
    });
    const app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;

    const users: { id: string; phone: string; token: string; email: string }[] = [];
    for (const name of ['Cliente A', 'Cliente B']) {
      const phone = randomPhone();
      const email = `booking-${randomUUID()}@example.com`;
      const user = await db.user.create({
        data: { name, phone, email, emailVerifiedAt: new Date(), passwordHash: 'no-login-test' },
      });
      const token = newToken();
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      users.push({ id: user.id, phone, token, email });
    }
    const [userA, userB] = users;
    const guestPhones: string[] = [];
    t.after(async () => {
      await app.close();
      await simulator.stop();
      const where = {
        OR: [{ userId: { in: users.map((u) => u.id) } }, { contactPhone: { in: guestPhones } }],
      };
      const ids = await db.appointment.findMany({ where, select: { id: true, calUid: true } });
      await db.integrationEvent.deleteMany({
        where: { sourceId: { in: ids.map((a) => a.calUid).filter((v): v is string => !!v) } },
      });
      await db.appointment.updateMany({ where, data: { rescheduledFromId: null } });
      await db.appointment.deleteMany({ where });
      await db.session.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
      await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
      process.env = saved;
      await db.$disconnect();
    });

    const call = (path: string, token = '', method = 'GET', body?: unknown) =>
      fetch(`${base}/${path}`, {
        method,
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          ...(token ? { Cookie: `instafix_session=${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const json = async (response: Response) => ({
      status: response.status,
      body: await response.json(),
    });

    // Días con disponibilidad en el simulador.
    const today = new Date();
    const end = new Date(today.getTime() + 20 * 86400000).toISOString().slice(0, 10);
    const availability = await json(
      await call(`booking/availability?start=${today.toISOString().slice(0, 10)}&end=${end}`),
    );
    assert.equal(availability.status, 200);
    const days = Object.keys(availability.body.days).sort();
    assert.ok(days.length >= 4, 'hay varios días con horarios');
    let slotIndex = 0;
    // Solo horarios a partir de mañana: cancelar/reprogramar exige 2 horas de antelación.
    const freeSlots = () =>
      days
        .flatMap((day) => availability.body.days[day] as { start: string }[])
        .map((s) => s.start)
        .filter((start) => Date.parse(start) > Date.now() + 86400000);
    const nextSlot = () => freeSlots()[slotIndex++ * 3];
    const request = 'Mi PS5 se apaga después de jugar unos minutos.';

    // Configuración: invitado vs. sesión (teléfono enmascarado).
    const guestConfig = await json(await call('booking/config'));
    assert.deepEqual([guestConfig.body.mode, guestConfig.body.user], ['native', null]);
    const config = await json(await call('booking/config', userA.token));
    assert.equal(config.body.user.name, 'Cliente A');
    assert.ok(!config.body.user.maskedPhone.includes(userA.phone.slice(4, 9)));
    assert.match(config.body.user.maskedPhone, /\*/);

    // Caso 27: usuario autenticado manipula el teléfono → se ignora.
    const forgedPhone = randomPhone();
    const key = randomUUID();
    const bookingBody = {
      requestKey: key,
      start: nextSlot(),
      device: 'PS5',
      customerRequest: request,
      whatsappConsent: true,
      phone: forgedPhone,
      userId: userB.id,
      guest: {
        firstName: 'Otra',
        lastName: 'Persona',
        phone: forgedPhone,
        email: 'otra@example.com',
      },
    };
    const created = await json(
      await call('booking/appointments', userA.token, 'POST', bookingBody),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.guest, false);
    assert.equal(created.body.appointment.status, 'CONFIRMED');
    const row = await db.appointment.findUniqueOrThrow({
      where: { id: created.body.appointment.id },
    });
    assert.equal(row.userId, userA.id);
    assert.equal(row.contactPhone, userA.phone);
    assert.equal(row.contactEmail, userA.email);
    assert.equal(row.customerRequest, request);
    assert.equal(row.contactName, 'Cliente A');
    assert.equal(row.source, 'INSTAFIX');
    assert.ok(row.calUid);
    const calBooking = simulator.bookings.get(row.calUid!)!;
    assert.equal(calBooking.attendees[0].phoneNumber, userA.phone);
    assert.equal(calBooking.bookingFieldsResponses.notes, request);
    assert.equal(calBooking.metadata.instafixAppointmentId, row.id);
    const events = await db.appointmentEvent.findMany({ where: { appointmentId: row.id } });
    assert.deepEqual(events.map((e) => e.type).sort(), [
      'appointment.confirmed',
      'appointment.created',
    ]);

    // Idempotencia: repetir y doble clic simultáneo con la misma clave no duplican.
    const bookingsBefore = simulator.bookings.size;
    const repeated = await json(
      await call('booking/appointments', userA.token, 'POST', bookingBody),
    );
    assert.equal(repeated.body.appointment.id, row.id);
    const doubleKey = randomUUID();
    const doubleBody = { ...bookingBody, requestKey: doubleKey, start: nextSlot() };
    const [first, second] = await Promise.all([
      call('booking/appointments', userA.token, 'POST', doubleBody),
      call('booking/appointments', userA.token, 'POST', doubleBody),
    ]);
    assert.ok([first.status, second.status].includes(201));
    assert.equal(await db.appointment.count({ where: { bookingKey: doubleKey } }), 1);
    assert.equal(simulator.bookings.size, bookingsBefore + 1);

    // Aparece de inmediato en Próximas, solo para su propietario.
    const mine = await json(await call('appointments/me', userA.token));
    assert.ok(mine.body.upcoming.some((a: { id: string }) => a.id === row.id));
    assert.ok(
      new Date(mine.body.upcoming[0].startsAt) <= new Date(mine.body.upcoming.at(-1).startsAt),
    );
    assert.equal((await call('appointments/me')).status, 401);

    // Caso 29: B no puede ver, cancelar ni reprogramar la cita de A.
    const others = await json(await call('appointments/me', userB.token));
    assert.equal(others.body.upcoming.length + others.body.history.length, 0);
    assert.equal((await call(`appointments/me/${row.id}`, userB.token)).status, 404);
    assert.equal(
      (await call(`appointments/me/${row.id}/cancel`, userB.token, 'POST', {})).status,
      404,
    );
    assert.equal(
      (
        await call(`appointments/me/${row.id}/reschedule`, userB.token, 'POST', {
          requestKey: randomUUID(),
          start: nextSlot(),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `appointments/me/${row.id}/availability?start=${days[0]}&end=${days[0]}`,
          userB.token,
        )
      ).status,
      404,
    );
    assert.equal(simulator.bookings.get(row.calUid!)!.status, 'accepted');

    // Caso 28: un invitado no puede usar el WhatsApp de una cuenta (en ningún formato).
    const localFormat = '0' + userA.phone.slice(4);
    for (const phone of [userA.phone, localFormat]) {
      const rejected = await json(
        await call('booking/appointments', '', 'POST', {
          ...bookingBody,
          requestKey: randomUUID(),
          start: nextSlot(),
          guest: {
            firstName: 'Invitado',
            lastName: 'Prueba',
            phone,
            email: 'invitado@example.com',
          },
        }),
      );
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.code, 'ACCOUNT_EXISTS');
      assert.match(rejected.body.message, /Inicia sesión/);
    }

    // Invitado con número nuevo: se normaliza a E.164 y queda sin cuenta.
    const guestPhone = randomPhone();
    guestPhones.push(guestPhone);
    const guest = await json(
      await call('booking/appointments', '', 'POST', {
        requestKey: randomUUID(),
        start: nextSlot(),
        device: 'Laptop',
        customerRequest: 'Quiero revisar mi laptop porque se calienta.',
        whatsappConsent: true,
        guest: {
          firstName: 'invitada',
          lastName: 'prueba',
          phone: '0' + guestPhone.slice(4),
          email: 'invitada@example.com',
        },
      }),
    );
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    assert.equal(guest.body.guest, true);
    const guestRow = await db.appointment.findUniqueOrThrow({
      where: { id: guest.body.appointment.id },
    });
    assert.equal(guestRow.userId, null);
    assert.equal(guestRow.contactPhone, guestPhone);
    assert.equal(guestRow.contactName, 'Invitada Prueba', 'nombre y apellido normalizados');
    assert.equal(guestRow.device, 'Por especificar', 'el cliente no clasifica el equipo');

    // Horario tomado mientras se completaba el formulario.
    clearAvailabilityCache();
    const contested = nextSlot();
    simulator.occupy(contested);
    const taken = await json(
      await call('booking/appointments', userA.token, 'POST', {
        ...bookingBody,
        requestKey: randomUUID(),
        start: contested,
      }),
    );
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'SLOT_TAKEN');
    // Carrera dentro de Cal.com: alguien reserva entre la revalidación y la creación.
    const raceKey = randomUUID();
    simulator.next.takeSlotBeforeCreate = true;
    const race = await json(
      await call('booking/appointments', userA.token, 'POST', {
        ...bookingBody,
        requestKey: raceKey,
        start: nextSlot(),
      }),
    );
    assert.equal(race.body.code, 'SLOT_TAKEN');
    const failed = await db.appointment.findUniqueOrThrow({ where: { bookingKey: raceKey } });
    assert.equal(failed.status, 'FAILED');
    const listed = await json(await call('appointments/me', userA.token));
    assert.ok(
      ![...listed.body.upcoming, ...listed.body.history].some(
        (a: { id: string }) => a.id === failed.id,
      ),
    );

    // Respuesta perdida tras crear en Cal.com: nunca «creada», y el reintento concilia sin duplicar.
    const uncertainKey = randomUUID();
    const uncertainBody = { ...bookingBody, requestKey: uncertainKey, start: nextSlot() };
    simulator.next.createFailure = 'timeout-after-create';
    const uncertain = await json(
      await call('booking/appointments', userA.token, 'POST', uncertainBody),
    );
    assert.equal(uncertain.status, 502);
    assert.equal(uncertain.body.code, 'UNCERTAIN');
    const pending = await db.appointment.findUniqueOrThrow({ where: { bookingKey: uncertainKey } });
    assert.equal(pending.status, 'CREATING');
    const recovered = await json(
      await call('booking/appointments', userA.token, 'POST', uncertainBody),
    );
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    const linkedRow = await db.appointment.findUniqueOrThrow({
      where: { bookingKey: uncertainKey },
    });
    assert.equal(linkedRow.status, 'CONFIRMED');
    assert.ok(linkedRow.calUid && simulator.bookings.has(linkedRow.calUid));

    // Webhook firmado e idempotente: cancelación hecha desde Cal.com.
    const signed = (payload: unknown) => {
      const raw = JSON.stringify(payload);
      return fetch(`${base}/webhooks/cal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cal-signature-256': createHmac('sha256', 'booking-test-secret')
            .update(raw)
            .digest('hex'),
        },
        body: raw,
      });
    };
    const cancelEvent = {
      triggerEvent: 'BOOKING_CANCELLED',
      createdAt: new Date().toISOString(),
      payload: {
        uid: linkedRow.calUid,
        eventTypeId: simulator.options.eventTypeId,
        cancellationReason: 'Cancelada desde Cal.com',
        metadata: { instafixAppointmentId: linkedRow.id },
      },
    };
    assert.equal((await signed(cancelEvent)).status, 200);
    assert.equal((await signed(cancelEvent)).status, 200);
    const cancelledRow = await db.appointment.findUniqueOrThrow({ where: { id: linkedRow.id } });
    assert.equal(cancelledRow.status, 'CANCELLED');
    assert.equal(
      await db.appointmentEvent.count({
        where: { appointmentId: linkedRow.id, type: 'appointment.cancelled' },
      }),
      1,
    );

    // Cancelación desde Mi cuenta: Cal.com primero, luego PostgreSQL.
    const cancel = await json(
      await call(`appointments/me/${row.id}/cancel`, userA.token, 'POST', {}),
    );
    assert.equal(cancel.status, 201, JSON.stringify(cancel.body));
    assert.equal(cancel.body.status, 'CANCELLED');
    assert.equal(simulator.bookings.get(row.calUid!)!.status, 'cancelled');
    const history = await json(await call('appointments/me', userA.token));
    assert.ok(history.body.history.some((a: { id: string }) => a.id === row.id));

    // Reprogramación desde Mi cuenta: nueva fila vinculada, la anterior queda RESCHEDULED.
    const toMove = await json(
      await call('booking/appointments', userA.token, 'POST', {
        ...bookingBody,
        requestKey: randomUUID(),
        start: nextSlot(),
      }),
    );
    clearAvailabilityCache();
    const target = nextSlot();
    const rescheduleKey = randomUUID();
    const moved = await json(
      await call(`appointments/me/${toMove.body.appointment.id}/reschedule`, userA.token, 'POST', {
        requestKey: rescheduleKey,
        start: target,
      }),
    );
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.startsAt, target);
    const oldRow = await db.appointment.findUniqueOrThrow({
      where: { id: toMove.body.appointment.id },
      include: { rescheduledTo: true },
    });
    assert.equal(oldRow.status, 'RESCHEDULED');
    assert.equal(oldRow.rescheduledTo?.id, moved.body.id);
    const again = await json(
      await call(`appointments/me/${toMove.body.appointment.id}/reschedule`, userA.token, 'POST', {
        requestKey: rescheduleKey,
        start: target,
      }),
    );
    assert.equal(again.body.id, moved.body.id);

    // Reprogramación hecha desde Cal.com (enlace del correo) → webhook crea la fila nueva.
    const movedRow = await db.appointment.findUniqueOrThrow({ where: { id: moved.body.id } });
    const externalUid = `sim_external_${randomUUID()}`;
    const externalStart = new Date(Date.parse(target) + 2 * 86400000);
    const rescheduleEvent = {
      triggerEvent: 'BOOKING_RESCHEDULED',
      createdAt: new Date().toISOString(),
      payload: {
        uid: externalUid,
        rescheduleUid: movedRow.calUid,
        eventTypeId: simulator.options.eventTypeId,
        startTime: externalStart.toISOString(),
        endTime: new Date(externalStart.getTime() + 3600000).toISOString(),
        attendees: [
          { name: 'Cambiado en Cal', email: 'otro@example.com', phoneNumber: forgedPhone },
        ],
        status: 'ACCEPTED',
        metadata: {},
      },
    };
    assert.equal((await signed(rescheduleEvent)).status, 200);
    const external = await db.appointment.findUniqueOrThrow({ where: { calUid: externalUid } });
    assert.equal(external.userId, userA.id);
    assert.equal(
      external.contactPhone,
      userA.phone,
      'los datos editados en Cal.com no cambian el contacto',
    );
    assert.equal(external.rescheduledFromId, movedRow.id);

    // No-show marcado en Cal.com.
    await db.appointment.update({
      where: { id: external.id },
      data: { startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000) },
    });
    const noShow = {
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: new Date().toISOString(),
      payload: {
        bookingUid: externalUid,
        bookingId: 1,
        attendees: [{ email: userA.email, noShow: true }],
      },
    };
    assert.equal((await signed(noShow)).status, 200);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: external.id } })).status,
      'NO_SHOW',
    );
    const finalList = await json(await call('appointments/me', userA.token));
    const historyDates = finalList.body.history.map((a: { startsAt: string }) =>
      Date.parse(a.startsAt),
    );
    assert.deepEqual(
      historyDates,
      [...historyDates].sort((a: number, b: number) => b - a),
    );
  },
);
