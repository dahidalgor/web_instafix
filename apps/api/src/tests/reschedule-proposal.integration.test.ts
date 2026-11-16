import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import webpush from 'web-push';
import { AppointmentsController } from '../appointments/appointments.controller';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import {
  enqueueAppointmentRequested,
  scheduleMissedCompletionReminders,
} from '../notifications/staff/staff-notifications';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';
import {
  answerProposal,
  proposalAnswer,
  proposalDeadline,
  sweepExpiredProposals,
} from '../staff/reschedule-proposal';
import { StaffController } from '../staff/staff.controller';
import { WhatsAppProviderError } from '../whatsapp/provider';
import { processJob } from '../whatsapp/worker';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
setPushSender(async () => {});

// Cal.com simulado: mover una reserva crea otra (uid «-r») en el horario nuevo.
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const move = url.match(/\/bookings\/([^/]+)\/reschedule$/);
  if (move) {
    const start = new Date(JSON.parse(String(init?.body)).start);
    return Response.json({
      status: 'success',
      data: {
        uid: `${decodeURIComponent(move[1])}-r`,
        status: 'accepted',
        start: start.toISOString(),
        end: new Date(start.getTime() + 7200000).toISOString(),
      },
    });
  }
  if (/\/confirm$/.test(url)) return Response.json({ status: 'success' });
  const get = url.match(/\/bookings\/([^/?]+)$/);
  if (get) return Response.json({ status: 'success', data: { status: 'accepted', uid: get[1] } });
  // Horarios: Cal.com «no responde» y la reserva se acepta sin verificar.
  return Response.json({}, { status: 500 });
}) as typeof fetch;

const phone = () => `+59398${randomInt(1000000, 9999999)}`;
const HOUR = 3600000;
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};

test('respuesta a la propuesta: solo los botones «Sí…» y «No…»', () => {
  assert.equal(proposalAnswer('Sí, me sirve'), 'YES');
  assert.equal(proposalAnswer('si me sirve'), 'YES');
  assert.equal(proposalAnswer('No, mantener'), 'NO');
  assert.equal(proposalAnswer('Nota: llego tarde'), null);
  assert.equal(proposalAnswer(null), null);
});

test('la propuesta espera como mucho 12 h y vence 2 h antes de la visita', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  const far = new Date(now.getTime() + 5 * 24 * HOUR);
  assert.deepEqual(proposalDeadline(now, far, far), new Date(now.getTime() + 12 * HOUR));
  const soon = new Date(now.getTime() + 6 * HOUR);
  assert.deepEqual(proposalDeadline(now, soon, far), new Date(soon.getTime() - 2 * HOUR));
  assert.equal(proposalDeadline(now, new Date(now.getTime() + 2 * HOUR), far), null);
});

test(
  'el técnico propone otro horario; el cliente acepta, rechaza o no responde por WhatsApp',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_API_KEY: 'cal_test',
      CAL_API_VERSION: '2026-02-25',
      CAL_EVENT_TYPE_ID: '777000002',
    });
    const people: string[] = [];
    const ids: string[] = [];
    // Solo el equipo de esta prueba cuenta para la disponibilidad mientras dura.
    const others = await db.user.findMany({
      where: { role: { in: ['TECHNICIAN', 'ADMIN'] }, active: true },
      select: { id: true },
    });
    await db.user.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { active: false },
    });
    t.after(async () => {
      await db.user.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { active: true },
      });
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.automationJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.integrationEvent.deleteMany({ where: { sourceId: { startsWith: 'proposal-' } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.adminAction.deleteMany({ where: { actorId: { in: people } } });
      await db.user.deleteMany({ where: { id: { in: people } } });
      process.env = saved;
    });
    async function member(name: string, role: 'TECHNICIAN' | 'ADMIN' = 'TECHNICIAN') {
      const user = await db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
      people.push(user.id);
      const token = newToken();
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + 6e5),
        },
      });
      const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
      await db.pushSubscription.create({
        data: {
          userId: user.id,
          endpoint,
          endpointHash: endpointHash(endpoint),
          p256dh: Buffer.from(webpush.generateVAPIDKeys().publicKey, 'base64url').toString(
            'base64url',
          ),
          auth: randomBytes(16).toString('base64url'),
          installationId: randomUUID(),
        },
      });
      const req = {
        headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
      } as unknown as Request;
      return { user, req };
    }
    const carlos = await member('Carlos Propone');
    const ana = await member('Ana Libre');
    const david = await member('David Admin', 'ADMIN');
    const staff = new StaffController();
    const day = Date.now() + randomInt(10, 50) * 24 * HOUR;
    const startsAt = new Date(Math.floor(day / HOUR) * HOUR);
    const visit = async (data: Record<string, unknown> = {}) => {
      const row = await db.appointment.create({
        data: {
          title: 'Mantenimiento PS5',
          device: 'PS5',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * HOUR),
          address: 'Cumbayá',
          contactName: 'Saúl Parra',
          contactPhone: phone(),
          whatsappConsentAt: new Date(),
          status: 'CONFIRMED',
          source: 'INSTAFIX_API',
          calUid: `proposal-${randomUUID()}`,
          calStatus: 'accepted',
          assignedTechnicianId: carlos.user.id,
          technician: carlos.user.name,
          confirmedAt: new Date(),
          ...data,
        },
      });
      ids.push(row.id);
      return row;
    };
    const answers = (id: string) =>
      db.notification.findMany({
        where: { appointmentId: id, kind: 'RESCHEDULE_ANSWERED', recipient: carlos.user.id },
        orderBy: { createdAt: 'asc' },
      });
    const proposed = new Date(startsAt.getTime() + 24 * HOUR).toISOString();

    const a = await visit();
    // Solo el técnico a cargo; sin autorización de WhatsApp no se puede.
    assert.equal(await status(staff.propose(a.id, { startsAt: proposed }, ana.req)), 403);
    const noConsent = await visit({ whatsappConsentAt: null });
    assert.equal(
      await status(staff.propose(noConsent.id, { startsAt: proposed }, carlos.req)),
      400,
    );
    assert.equal(await status(staff.propose(a.id, { startsAt: 'mañana' }, carlos.req)), 400);

    // 1) Propone y el cliente dice que no: la visita sigue igual y Carlos se entera.
    const first = await staff.propose(a.id, { startsAt: proposed }, carlos.req);
    assert.equal(first.proposal?.startsAt, proposed);
    assert.ok(
      await db.automationJob.findFirst({
        where: { appointmentId: a.id, kind: 'RESCHEDULE_PROPOSAL', status: 'PENDING' },
      }),
      'WhatsApp con botones',
    );
    assert.equal(
      await answerProposal({ phone: a.contactPhone, text: 'No, mantener', inReplyTo: null }),
      'DECLINED',
    );
    let row = await db.appointment.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(row.startsAt.getTime(), startsAt.getTime());
    assert.equal(row.proposedStartsAt, null);
    assert.match(
      ((await answers(a.id))[0].data as { title: string }).title,
      /Saúl prefiere mantener el horario/,
    );
    // Tocar el botón otra vez no hace nada.
    assert.equal(
      await answerProposal({ phone: a.contactPhone, text: 'No, mantener', inReplyTo: null }),
      null,
    );

    // 2) Propone otra vez y el cliente acepta (respondiendo al mensaje): se mueve y sigue con
    //    Carlos; el cliente recibe «confirmada» con la fecha nueva.
    await staff.propose(a.id, { startsAt: proposed }, carlos.req);
    const job = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: a.id, kind: 'RESCHEDULE_PROPOSAL', status: 'PENDING' },
    });
    const wam = `wam_${randomUUID()}`;
    await db.automationJob.update({
      where: { id: job.id },
      data: { status: 'SENT', providerMessageId: wam },
    });
    assert.equal(
      await answerProposal({ phone: a.contactPhone, text: 'Sí, me sirve', inReplyTo: wam }),
      'ACCEPTED',
    );
    row = await db.appointment.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(row.startsAt.toISOString(), proposed);
    assert.equal(row.status, 'CONFIRMED');
    assert.equal(row.assignedTechnicianId, carlos.user.id);
    assert.equal(row.calUid, `${a.calUid}-r`);
    assert.equal(row.proposedStartsAt, null);
    const after = await db.automationJob.findMany({
      where: { appointmentId: a.id, revision: row.automationRevision },
    });
    assert.ok(after.some((j) => j.kind === 'CONFIRMED'));
    assert.ok(!after.some((j) => j.kind === 'RESCHEDULED'));
    assert.match(
      ((await answers(a.id)).at(-1)!.data as { title: string }).title,
      /aceptó el cambio/,
    );

    // 3) Propone y el cliente no responde a tiempo.
    const later = new Date(row.startsAt.getTime() + 24 * HOUR).toISOString();
    await staff.propose(a.id, { startsAt: later }, carlos.req);
    await db.appointment.update({
      where: { id: a.id },
      data: { proposalExpiresAt: new Date(Date.now() - 1000) },
    });
    await sweepExpiredProposals();
    row = await db.appointment.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(row.proposedStartsAt, null);
    assert.equal(row.startsAt.toISOString(), proposed);
    assert.match(((await answers(a.id)).at(-1)!.data as { title: string }).title, /no respondió/);

    // 4) Retirar la propuesta: el WhatsApp aún no enviado ya no sale.
    await staff.propose(a.id, { startsAt: later }, carlos.req);
    const withdrawn = await staff.withdrawProposal(a.id, carlos.req);
    assert.equal(withdrawn.proposal, null);
    assert.equal(
      await db.automationJob.count({
        where: { appointmentId: a.id, kind: 'RESCHEDULE_PROPOSAL', status: 'PENDING' },
      }),
      0,
    );

    // 5) Administración cambia el técnico: el cliente recibe el WhatsApp del cambio.
    await new AppointmentsController().reassignAppointment(
      a.id,
      { technicianId: ana.user.id },
      david.req,
    );
    assert.ok(
      await db.automationJob.findFirst({
        where: { appointmentId: a.id, kind: 'TECHNICIAN_CHANGED', status: 'PENDING' },
      }),
    );

    // 6) Una solicitud nueva en un horario en que solo Ana está libre: su aviso lo dice.
    await db.technicianBusyBlock.create({
      data: {
        userId: carlos.user.id,
        label: 'Clases',
        date: new Date(startsAt.getTime() - 5 * HOUR).toISOString().slice(0, 10),
        startMinute: 0,
        endMinute: 1440,
      },
    });
    await db.technicianBusyBlock.create({
      data: {
        userId: david.user.id,
        label: 'Reunión',
        date: new Date(startsAt.getTime() - 5 * HOUR).toISOString().slice(0, 10),
        startMinute: 0,
        endMinute: 1440,
      },
    });
    const request = await visit({
      status: 'PENDING_LOCATION',
      assignedTechnicianId: null,
      technician: '',
      confirmedAt: null,
      calUid: null,
      startsAt: new Date(startsAt.getTime() + 2 * HOUR),
      endsAt: new Date(startsAt.getTime() + 4 * HOUR),
    });
    await db.$transaction((tx) => enqueueAppointmentRequested(tx, request));
    const offer = await db.notification.findFirstOrThrow({
      where: { appointmentId: request.id, kind: 'APPOINTMENT_REQUESTED', recipient: ana.user.id },
    });
    assert.match((offer.data as { body: string }).body, /Eres el único técnico disponible/);
    const pending = (await staff.pending(ana.req)).find((p) => p.id === request.id);
    assert.equal(pending?.onlyYouFree, true);
    await db.technicianBusyBlock.deleteMany({
      where: { userId: { in: [carlos.user.id, david.user.id] } },
    });

    // 7) «Ubicación recibida» sin plantilla aprobada todavía: no sale otra ni se reintenta.
    await db.appointment.update({
      where: { id: request.id },
      data: { locationReceivedAt: new Date() },
    });
    const received = await db.automationJob.create({
      data: {
        dedupeKey: `${request.id}:0:LOCATION_RECEIVED`,
        appointmentId: request.id,
        revision: request.automationRevision,
        kind: 'LOCATION_RECEIVED',
        dueAt: new Date(),
        expiresAt: request.startsAt,
        recipient: request.contactPhone,
      },
    });
    const envSaved = { ...process.env };
    Object.assign(process.env, { WHATSAPP_ENABLED: 'true', WHATSAPP_SENDING_ENABLED: 'true' });
    await processJob(received.id, {
      send: async () => {
        throw new WhatsAppProviderError('TEMPLATE_NOT_APPROVED', 'En revisión', 'FAILED');
      },
      confirm: async () => {},
    });
    process.env = envSaved;
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: received.id } })).status,
      'CANCELLED',
    );

    // 8) La visita fue ayer y no se pudo hacer: Carlos recibe a la mañana siguiente «sigue
    //    abierta» y aún puede proponer otro horario.
    const yesterday = new Date(Date.now() - 26 * HOUR);
    const missed = await visit({
      startsAt: yesterday,
      endsAt: new Date(yesterday.getTime() + 2 * HOUR),
    });
    await scheduleMissedCompletionReminders();
    const morning = await db.notification.findMany({
      where: { appointmentId: missed.id, kind: 'COMPLETION_REMINDER', recipient: carlos.user.id },
    });
    assert.ok(
      morning.some((n) => /propón otro horario/.test((n.data as { body: string }).body)),
      'aviso de la mañana siguiente',
    );
    await scheduleMissedCompletionReminders();
    assert.equal(
      await db.notification.count({
        where: { appointmentId: missed.id, kind: 'COMPLETION_REMINDER' },
      }),
      morning.length,
      'sin duplicados',
    );
    const retry = new Date(Date.now() + 3 * 24 * HOUR).toISOString();
    const missedProposal = await staff.propose(missed.id, { startsAt: retry }, carlos.req);
    assert.equal(missedProposal.proposal?.startsAt, retry);
  },
);
