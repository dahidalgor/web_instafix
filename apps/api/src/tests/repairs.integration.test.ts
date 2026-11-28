import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import {
  adminRepairs,
  answerRepairFromWhatsApp,
  createRepair,
  customerAnswerRepair,
  customerRepairs,
  deliverRepair,
  quoteRepair,
  repairsForVisit,
  setRepairStatus,
} from '../repairs/repairs.service';
import { processJob } from '../whatsapp/worker';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const phone = () => `+59395${randomInt(1000000, 9999999)}`;

test(
  'taller: el técnico registra el equipo, administración presupuesta y entrega, el cliente responde',
  { skip: !enabled },
  async (t) => {
    const make = (name: string, role: 'TECHNICIAN' | 'ADMIN' | 'CUSTOMER') =>
      db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
    const tech = await make('Teo Taller', 'TECHNICIAN');
    const other = await make('Otro Técnico', 'TECHNICIAN');
    const admin = await make('Ada Taller', 'ADMIN');
    const customer = await make('Clara Cliente', 'CUSTOMER');
    const stranger = await make('Otra Cliente', 'CUSTOMER');
    const start = new Date(Date.now() - 2 * 3600000);
    const visit = await db.appointment.create({
      data: {
        title: 'Mantenimiento PS5',
        device: 'PS5',
        startsAt: start,
        endsAt: new Date(start.getTime() + 2 * 3600000),
        address: 'Cumbayá',
        technician: tech.name,
        contactName: 'Clara Cliente',
        contactPhone: customer.phone,
        whatsappConsentAt: new Date(),
        userId: customer.id,
        status: 'CONFIRMED',
        source: 'INSTAFIX_API',
        calUid: `repair-${randomUUID()}`,
        assignedTechnicianId: tech.id,
        confirmedAt: start,
      },
    });
    t.after(async () => {
      await db.notification.deleteMany({ where: { appointmentId: visit.id } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: visit.id } });
      await db.appointment.deleteMany({ where: { id: visit.id } });
      await db.user.deleteMany({
        where: { id: { in: [tech.id, other.id, admin.id, customer.id, stranger.id] } },
      });
    });
    const asTech = (u: typeof tech) => ({ ...u, role: 'TECHNICIAN' }) as StaffUser;
    const intake = {
      device: 'Control DualSense',
      reportedFault: 'Drift en el joystick izquierdo',
      intakeCondition: 'Sin cable, rayón en la tapa',
    };

    // Solo el técnico a cargo registra equipos.
    await assert.rejects(createRepair(asTech(other), visit.id, intake), /técnico a cargo/);
    const order = await createRepair(asTech(tech), visit.id, intake);
    assert.match(order.code, /^T-\d{4,}$/);
    assert.equal(order.status, 'RECEIVED');
    assert.ok(
      await db.automationJob.findFirst({
        where: { repairOrderId: order.id, kind: 'REPAIR_RECEIVED', status: 'PENDING' },
      }),
      'comprobante «nos llevamos tu equipo» al cliente',
    );
    assert.equal((await repairsForVisit(asTech(tech), visit.id)).length, 1);
    assert.ok((await adminRepairs('shop')).items.some((o) => o.id === order.id));

    // Administración: diagnóstico y presupuesto → WhatsApp con botones al cliente.
    await setRepairStatus(admin.id, order.id, 'DIAGNOSING');
    await assert.rejects(setRepairStatus(admin.id, order.id, 'READY'), /no corresponde/);
    const quoted = await quoteRepair(admin.id, order.id, {
      quoteMinor: 3500,
      quoteNote: 'Joystick magnético',
    });
    assert.equal(quoted.status, 'QUOTED');
    const job = await db.automationJob.findFirstOrThrow({
      where: { repairOrderId: order.id, kind: 'REPAIR_QUOTE', status: 'PENDING' },
    });
    // El worker lo envía aunque la visita ya pasó, con equipo, orden y valor.
    let sentExtra: Record<string, string> | undefined;
    const wam = `wam_${randomUUID()}`;
    await processJob(job.id, {
      send: async (_a, _k, extra) => {
        sentExtra = extra as Record<string, string>;
        return { providerMessageId: wam, provider: 'BIRD' };
      },
      confirm: async () => {},
    });
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).status,
      'SENT',
    );
    assert.equal(sentExtra?.equipo, 'Control DualSense');
    assert.equal(sentExtra?.orden, order.code);
    assert.match(sentExtra?.valor ?? '', /35,00/);

    // El cliente pulsa «Sí, continuar» respondiendo al mensaje.
    assert.equal(
      await answerRepairFromWhatsApp({
        phone: customer.phone,
        text: 'Sí, continuar',
        inReplyTo: wam,
      }),
      'APPROVED',
    );
    let row = await db.repairOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, 'APPROVED');
    assert.equal(row.quoteAnsweredVia, 'WHATSAPP');
    assert.ok(
      await db.notification.findFirst({
        where: { appointmentId: visit.id, kind: 'REPAIR_ANSWERED', recipient: admin.id },
      }),
      'administración se entera',
    );
    // Tocar el botón otra vez no hace nada.
    assert.equal(
      await answerRepairFromWhatsApp({
        phone: customer.phone,
        text: 'No, devolver',
        inReplyTo: wam,
      }),
      null,
    );
    await setRepairStatus(admin.id, order.id, 'READY');
    const ready = await db.automationJob.findFirstOrThrow({
      where: { repairOrderId: order.id, kind: 'REPAIR_READY', status: 'PENDING' },
    });
    const delivered = await deliverRepair(admin.id, order.id, {
      returned: false,
      finalMinor: 3500,
    });
    assert.equal(delivered.status, 'DELIVERED');
    // Ya entregado: el «está listo» que no alcanzó a salir ya no se envía.
    await processJob(ready.id, {
      send: async () => ({ providerMessageId: `wam_${randomUUID()}`, provider: 'BIRD' }),
      confirm: async () => {},
    });
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: ready.id } })).status,
      'CANCELLED',
    );
    assert.ok(!(await adminRepairs('shop')).items.some((o) => o.id === order.id));
    assert.ok((await adminRepairs('done')).items.some((o) => o.id === order.id));

    // Segundo equipo: el cliente responde desde Mi cuenta → el WhatsApp pendiente ya no sale.
    const second = await createRepair(asTech(tech), visit.id, { ...intake, device: 'PS4 Slim' });
    await quoteRepair(admin.id, second.id, { quoteMinor: 6000 });
    const mine = await customerRepairs(customer.id);
    assert.deepEqual(mine.map((o) => o.id).sort(), [order.id, second.id].sort());
    assert.equal((await customerRepairs(stranger.id)).length, 0, 'otro cliente no lo ve');
    await assert.rejects(customerAnswerRepair(stranger.id, second.id, 'APPROVED'));
    const declined = await customerAnswerRepair(customer.id, second.id, 'DECLINED');
    assert.equal(declined.status, 'DECLINED');
    assert.equal(declined.quoteAnsweredVia, 'ACCOUNT');
    assert.equal(
      await db.automationJob.count({
        where: { repairOrderId: second.id, kind: 'REPAIR_QUOTE', status: 'PENDING' },
      }),
      0,
      'respondido en Mi cuenta: no sale el WhatsApp',
    );
    await assert.rejects(deliverRepair(admin.id, second.id, { returned: false, finalMinor: 0 }));
    const returned = await deliverRepair(admin.id, second.id, { returned: true, finalMinor: 0 });
    assert.equal(returned.status, 'RETURNED');
    row = await db.repairOrder.findUniqueOrThrow({ where: { id: second.id } });
    assert.ok(row.deliveredAt);
  },
);
