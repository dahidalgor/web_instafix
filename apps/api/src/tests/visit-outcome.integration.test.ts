import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AppointmentsController } from '../appointments/appointments.controller';
import type { StaffUser } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { completeAppointment } from '../staff/staff-appointments.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const phone = () => `+59396${randomInt(1000000, 9999999)}`;

test(
  'resultado de la visita: cobrada, solo visita técnica ($5) o sin cobro con motivo y revisión',
  { skip: !enabled },
  async (t) => {
    const make = (name: string, role: 'TECHNICIAN' | 'ADMIN') =>
      db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
    const tech = await make('Tito Resultado', 'TECHNICIAN');
    const admin = await make('Ada Revisa', 'ADMIN');
    const token = newToken();
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 6e5),
      },
    });
    const adminReq = {
      headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    } as unknown as Request;
    const ids: string[] = [];
    t.after(async () => {
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.completedJob.deleteMany({ where: { appointmentId: { in: ids } } }).catch(() => {});
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.id } });
      await db.user.deleteMany({ where: { id: { in: [tech.id, admin.id] } } });
    });
    const visit = async () => {
      const start = new Date(Date.now() - 3 * 3600000);
      const row = await db.appointment.create({
        data: {
          title: 'Mando con drift',
          device: 'DualSense',
          startsAt: start,
          endsAt: new Date(start.getTime() + 2 * 3600000),
          address: 'Cumbayá',
          technician: tech.name,
          contactName: 'Clara Resultado',
          contactPhone: phone(),
          status: 'CONFIRMED',
          source: 'INSTAFIX_API',
          calUid: `outcome-${randomUUID()}`,
          assignedTechnicianId: tech.id,
          confirmedAt: start,
        },
      });
      ids.push(row.id);
      return row;
    };
    const asTech = { ...tech, role: 'TECHNICIAN' } as StaffUser;
    const service = (appointmentId: string, totalMinor: number) =>
      db.appointmentService.create({
        data: {
          appointmentId,
          nameSnapshot: 'Joystick magnético',
          deviceSnapshot: 'DualSense',
          unitPriceMinor: totalMinor,
          totalMinor,
        },
      });

    // Sin servicios ni resultado: hay que elegir.
    const empty = await visit();
    await assert.rejects(completeAppointment(asTech, empty.id), /resultado de la visita/);
    // «Se cobró» sin servicios con valor: no.
    await assert.rejects(
      completeAppointment(asTech, empty.id, new Date(), { outcome: 'CHARGED' }),
      /No registraste servicios cobrados/,
    );

    // 1) Con servicios cobrados (como antes, sin indicar resultado): CHARGED.
    const paid = await visit();
    await service(paid.id, 2000);
    await completeAppointment(asTech, paid.id);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: paid.id } })).outcome,
      'CHARGED',
    );

    // 2) Solo visita técnica: se registra su cargo de $5.
    const fee = await visit();
    await completeAppointment(asTech, fee.id, new Date(), { outcome: 'VISIT_FEE' });
    const feeLines = await db.appointmentService.findMany({ where: { appointmentId: fee.id } });
    assert.deepEqual(
      feeLines.map((s) => [s.nameSnapshot, s.totalMinor]),
      [['Visita técnica', 500]],
    );
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: fee.id } })).outcome,
      'VISIT_FEE',
    );
    //    Con otros servicios cobrados no es «solo visita técnica».
    const mixed = await visit();
    await service(mixed.id, 3000);
    await assert.rejects(
      completeAppointment(asTech, mixed.id, new Date(), { outcome: 'VISIT_FEE' }),
      /Ya registraste servicios cobrados/,
    );

    // 3) Sin cobro: motivo y explicación obligatorios; administración recibe el aviso.
    const none = await visit();
    await assert.rejects(
      completeAppointment(asTech, none.id, new Date(), { outcome: 'NO_CHARGE' }),
      /por qué no se cobró/,
    );
    await assert.rejects(
      completeAppointment(asTech, none.id, new Date(), {
        outcome: 'NO_CHARGE',
        noChargeReason: 'INCOMPATIBLE_PART',
        noChargeNote: 'no',
      }),
      /Explica qué pasó/,
    );
    await completeAppointment(asTech, none.id, new Date(), {
      outcome: 'NO_CHARGE',
      noChargeReason: 'INCOMPATIBLE_PART',
      noChargeNote: 'El joystick que llevé no era compatible con su modelo.',
    });
    let row = await db.appointment.findUniqueOrThrow({ where: { id: none.id } });
    assert.equal(row.outcome, 'NO_CHARGE');
    assert.equal(row.noChargeReason, 'INCOMPATIBLE_PART');
    assert.equal(row.noChargeReviewedAt, null);
    assert.ok(
      await db.notification.findFirst({
        where: { appointmentId: none.id, kind: 'NO_CHARGE_REVIEW', recipient: admin.id },
      }),
      'aviso a administración',
    );
    //    Sin cobro no admite servicios con valor.
    const withValue = await visit();
    await service(withValue.id, 1500);
    await assert.rejects(
      completeAppointment(asTech, withValue.id, new Date(), {
        outcome: 'NO_CHARGE',
        noChargeReason: 'OTHER',
        noChargeNote: 'Explicación suficientemente larga.',
      }),
      /Registraste servicios con valor/,
    );

    // Revisión: aparece en «Sin cobro por revisar»; marcada sigue ahí; aprobada sale.
    const admins = new AppointmentsController();
    const inReview = async () =>
      (
        await admins.adminAppointments(adminReq, { status: 'noChargeReview', pageSize: '50' })
      ).items.some((a) => a.id === none.id);
    assert.ok(await inReview());
    await admins.reviewNoCharge(none.id, { decision: 'FLAGGED' }, adminReq);
    row = await db.appointment.findUniqueOrThrow({ where: { id: none.id } });
    assert.equal(row.noChargeFlagged, true);
    assert.ok(await inReview(), 'marcada: sigue pendiente de resolver');
    await admins.reviewNoCharge(none.id, { decision: 'APPROVED' }, adminReq);
    assert.ok(!(await inReview()));
    // Solo visitas sin cobro se revisan.
    await assert.rejects(admins.reviewNoCharge(paid.id, { decision: 'APPROVED' }, adminReq));
  },
);
