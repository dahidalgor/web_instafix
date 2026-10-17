import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { db } from '../database/client';
import { newToken, tokenHash } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { SiteController } from '../site/site.controller';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AppointmentsController } from '../appointments/appointments.controller';
import { JobsController } from '../jobs/jobs.controller';

test(
  'account-prefilled booking, technician service assignment, slides and private analytics persist safely',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const ids: string[] = [];
    const slideIds: string[] = [];
    const calIds: string[] = [];
    const offeringId = `test-${randomUUID()}`;
    const visitId = randomUUID();
    const sessionId = randomUUID();
    const eventType = process.env.CAL_EVENT_TYPE_ID;
    process.env.CAL_EVENT_TYPE_ID = '991991';
    const req = (token = '') =>
      ({
        headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
      }) as Request;
    const guests = req();
    try {
      const requests: Request[] = [];
      for (const role of ['CUSTOMER', 'ADMIN'] as const) {
        const user = await db.user.create({
          data: {
            name: 'Prueba Sitio',
            phone:
              role === 'CUSTOMER'
                ? `+5939${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
                : `test-${randomUUID()}`,
            email: `test-${randomUUID()}@example.com`,
            emailVerifiedAt: new Date(),
            role,
            passwordHash: 'not-a-login',
          },
        });
        ids.push(user.id);
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
      const [customer, admin] = requests;
      const booking = new BookingController();
      assert.deepEqual(await booking.context(guests), { token: null, user: null });
      const context = await booking.context(customer);
      assert.equal(context.user?.id, ids[0]);
      assert.ok(context.token);
      const stored = await db.bookingIntent.findUniqueOrThrow({
        where: { tokenHash: tokenHash(context.token!) },
      });
      assert.notEqual(stored.tokenHash, context.token);
      const event = (reference: string | null, email: string) => {
        const uid = `site-test-${randomUUID()}`;
        calIds.push(uid);
        return {
          triggerEvent: 'BOOKING_REQUESTED',
          createdAt: new Date().toISOString(),
          payload: {
            uid,
            eventTypeId: 991991,
            startTime: new Date(Date.now() + 86400000).toISOString(),
            endTime: new Date(Date.now() + 90000000).toISOString(),
            attendees: [{ name: 'Prueba Sitio', email, phoneNumber: context.user!.phone }],
            metadata: { instafixReference: reference },
            responses: {
              servicio: { value: 'Mi consola se apaga' },
              whatsappConsent: { value: true },
            },
          },
        };
      };
      const original = event(context.token, context.user!.email!);
      await receiveCalWebhook(original);
      const appointment = await db.appointment.findUniqueOrThrow({
        where: { calUid: original.payload.uid },
      });
      assert.equal(appointment.userId, ids[0]);
      assert.equal(appointment.offeringId, null);
      assert.equal(appointment.title, 'Mi consola se apaga');
      // Reusar un token en otra reserva o cambiar la identidad no permite apropiarse de una cuenta.
      const replay = event(context.token, context.user!.email!);
      await receiveCalWebhook(replay);
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { calUid: replay.payload.uid } })).userId,
        null,
      );
      const second = await booking.context(customer);
      const mismatch = event(second.token, 'someone-else@example.com');
      await receiveCalWebhook(mismatch);
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { calUid: mismatch.payload.uid } }))
          .userId,
        ids[0],
      );
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { calUid: mismatch.payload.uid } }))
          .bookingIdentityIssue,
        'EMAIL_MISMATCH',
      );
      const offering = await db.offering.create({
        data: {
          id: offeringId,
          category: 'Test',
          device: 'PS5',
          title: 'Mantenimiento técnico',
          priceMinor: 2500,
          durationMinutes: 60,
        },
      });
      const appointments = new AppointmentsController();
      await assert.rejects(appointments.assignService(appointment.id, { offeringId }, customer));
      await appointments.assignService(appointment.id, { offeringId }, admin);
      const assigned = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.equal(assigned.offeringId, offering.id);
      assert.equal(assigned.title, appointment.title);
      const jobs = new JobsController();
      const job = {
        userId: ids[0],
        offeringId,
        appointmentId: appointment.id,
        priceMinor: 2500,
        completedAt: new Date(Date.now() - 1000).toISOString(),
        warrantyEndsAt: new Date(Date.now() + 86400000).toISOString(),
        warrantyTerms: 'Garantía de prueba',
      };
      await assert.rejects(jobs.addJob(job, customer));
      const saved = await jobs.addJob(job, admin);
      assert.equal(saved.title, offering.title);
      await assert.rejects(jobs.addJob(job, admin));
      assert.equal(
        await db.automationJob.count({
          where: { appointmentId: appointment.id, status: 'PENDING' },
        }),
        0,
      );
      await db.offering.update({
        where: { id: offeringId },
        data: { title: 'Título posterior', priceMinor: 9900 },
      });
      assert.equal(
        (await db.completedJob.findUniqueOrThrow({ where: { id: saved.id } })).priceMinor,
        2500,
      );
      const slides = new SiteController();
      const draft = {
        label: 'Prueba',
        title: 'Diapositiva de prueba',
        description: 'Descripción de prueba aislada',
        detail: '',
        position: 999,
        published: false,
        media: [],
      };
      await assert.rejects(slides.create(customer, draft));
      const slide = await slides.create(admin, draft);
      slideIds.push(slide.id);
      assert.equal(
        (await slides.slides()).some((s) => s.id === slide.id),
        false,
      );
      await slides.update(admin, slide.id, { ...draft, published: true });
      assert.equal(
        (await slides.slides()).some((s) => s.id === slide.id),
        true,
      );
      const analytics = new AnalyticsController();
      const visit = { id: visitId, sessionId, page: 'contacto', activeSeconds: 0 };
      await analytics.visit(guests, visit);
      await db.pageVisit.update({
        where: { id: visitId },
        data: { createdAt: new Date(Date.now() - 60000) },
      });
      await analytics.visit(guests, { ...visit, activeSeconds: 45 });
      await analytics.visit(guests, { ...visit, activeSeconds: 20 });
      assert.equal(
        (await db.pageVisit.findUniqueOrThrow({ where: { id: visitId } })).activeSeconds,
        45,
      );
      await analytics.visit(guests, { ...visit, activeSeconds: 14000 });
      assert.ok(
        (await db.pageVisit.findUniqueOrThrow({ where: { id: visitId } })).activeSeconds <= 66,
      );
      await assert.rejects(analytics.summary(customer));
      assert.ok((await analytics.summary(admin)).pages.some((p) => p.page === 'contacto'));
    } finally {
      if (eventType === undefined) delete process.env.CAL_EVENT_TYPE_ID;
      else process.env.CAL_EVENT_TYPE_ID = eventType;
      await db.completedJob.deleteMany({ where: { userId: { in: ids } } });
      await db.appointment.deleteMany({ where: { calUid: { in: calIds } } });
      await db.integrationEvent.deleteMany({
        where: { provider: 'CAL', sourceId: { in: calIds } },
      });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.offering.deleteMany({ where: { id: offeringId } });
      await db.siteSlide.deleteMany({ where: { id: { in: slideIds } } });
      await db.pageVisit.deleteMany({ where: { id: visitId } });
      await db.$disconnect();
    }
  },
);
