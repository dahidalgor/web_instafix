// Simulador LOCAL de Cal.com API v2 para pruebas y desarrollo sin tocar la agenda real.
// Reproduce solo los endpoints que usa InstaFix (slots, crear, consultar, cancelar,
// reprogramar, confirmar, listar) con los mismos encabezados y formas de respuesta.
// Nunca se usa en producción: la API solo lo llama si CAL_API_BASE_URL apunta aquí.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CAL_VERSIONS, localDate, zonedDayStartUtc } from '../integrations/cal-api';

type Booking = {
  uid: string;
  status: string;
  start: string;
  end: string;
  eventTypeId: number;
  attendees: { name: string; email: string; phoneNumber?: string; timeZone: string }[];
  bookingFieldsResponses: Record<string, unknown>;
  metadata: Record<string, string>;
  rescheduledFromUid?: string;
  rescheduledToUid?: string;
};

export type SimulatorOptions = {
  apiKey?: string;
  eventTypeId?: number;
  timeZone?: string;
  /** Duración del evento en minutos. */
  length?: number;
  /** Horas de atención locales [inicio, fin) y días laborables (0 = domingo). */
  hours?: [number, number];
  weekdays?: number[];
  /** pending reproduce un evento con «requiere confirmación». */
  initialStatus?: 'pending' | 'accepted';
};

export class CalSimulator {
  bookings = new Map<string, Booking>();
  calls: { method: string; path: string; version: string | undefined }[] = [];
  /** Fallos inyectables para probar timeouts, rechazos y condiciones de carrera. */
  next: {
    createFailure?: 'timeout-after-create' | 'server-error' | 'reject';
    takeSlotBeforeCreate?: boolean;
  } = {};
  server?: Server;
  url = '';
  readonly options: Required<SimulatorOptions>;

  constructor(options: SimulatorOptions = {}) {
    this.options = {
      apiKey: 'cal_test_simulator',
      eventTypeId: 4242,
      timeZone: 'America/Guayaquil',
      length: 60,
      hours: [9, 17],
      weekdays: [1, 2, 3, 4, 5, 6],
      initialStatus: 'pending',
      ...options,
    };
  }

  async start(port = 0) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => this.send(res, 500, { status: 'error' }));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/v2`;
    return this;
  }

  async stop() {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private taken(start: number, ignoreUid?: string) {
    const length = this.options.length * 60000;
    return [...this.bookings.values()].some(
      (b) =>
        b.uid !== ignoreUid &&
        !['cancelled', 'rejected'].includes(b.status) &&
        start < Date.parse(b.end) &&
        Date.parse(b.start) < start + length,
    );
  }

  /** Horarios libres entre dos instantes, como Cal.com con format=range. */
  slots(from: Date, to: Date, ignoreUid?: string) {
    const { timeZone, hours, weekdays, length } = this.options;
    const result: Record<string, { start: string; end: string }[]> = {};
    for (let day = new Date(from); day <= to; day = new Date(day.getTime() + 86400000)) {
      const key = localDate(day, timeZone);
      const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
      if (!weekdays.includes(weekday)) continue;
      const midnight = zonedDayStartUtc(key, timeZone).getTime();
      for (let h = hours[0]; h + length / 60 <= hours[1]; h++) {
        const start = midnight + h * 3600000;
        if (start < from.getTime() || start > to.getTime() || start <= Date.now()) continue;
        if (this.taken(start, ignoreUid)) continue;
        (result[key] ??= []).push({
          start: new Date(start).toISOString(),
          end: new Date(start + length * 60000).toISOString(),
        });
      }
    }
    return result;
  }

  /** Simula que otra persona reserva un horario (para probar la condición de carrera). */
  occupy(start: string) {
    const uid = `external-${randomUUID()}`;
    this.bookings.set(uid, {
      uid,
      status: 'accepted',
      start,
      end: new Date(Date.parse(start) + this.options.length * 60000).toISOString(),
      eventTypeId: this.options.eventTypeId,
      attendees: [{ name: 'Otra persona', email: 'otra@example.com', timeZone: 'UTC' }],
      bookingFieldsResponses: {},
      metadata: {},
    });
    return uid;
  }

  private async body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/v2/, '');
    const version = req.headers['cal-api-version'] as string | undefined;
    this.calls.push({ method: req.method ?? 'GET', path, version });
    if (req.headers.authorization !== `Bearer ${this.options.apiKey}`)
      return this.send(res, 401, {
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
      });
    const error = (status: number, message: string) =>
      this.send(res, status, { status: 'error', error: { code: 'BAD_REQUEST', message } });

    if (req.method === 'GET' && path === '/slots') {
      if (version !== CAL_VERSIONS.slots) return error(400, 'Unsupported cal-api-version');
      if (Number(url.searchParams.get('eventTypeId')) !== this.options.eventTypeId)
        return error(404, 'Event type not found');
      const from = new Date(url.searchParams.get('start') ?? '');
      const to = new Date(url.searchParams.get('end') ?? '');
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        return error(400, 'Invalid range');
      const ignore = url.searchParams.get('bookingUidToReschedule') ?? undefined;
      return this.send(res, 200, { status: 'success', data: this.slots(from, to, ignore) });
    }

    if (req.method === 'POST' && path === '/bookings') {
      if (version !== CAL_VERSIONS.bookings) return error(400, 'Unsupported cal-api-version');
      const input = await this.body(req);
      if (input.eventTypeId !== this.options.eventTypeId) return error(404, 'Event type not found');
      if (!input.attendee?.name || !input.attendee?.timeZone || !input.attendee?.email)
        return error(400, 'attendee name, email and timeZone are required');
      if (!input.attendee?.phoneNumber) return error(400, 'attendeePhoneNumber is required');
      // Cal.com real rechaza dominios sin correo (p. ej. example.com en producción).
      if (String(input.attendee.email).endsWith('@invalid.test'))
        return error(400, 'This email address cannot receive mail. Please use a valid email.');
      for (const field of ['notes'])
        if (input.bookingFieldsResponses?.[field] === undefined)
          return error(400, `responses - {${field}}error_required_field`);
      const start = Date.parse(input.start);
      if (this.next.takeSlotBeforeCreate) {
        this.next.takeSlotBeforeCreate = false;
        this.occupy(new Date(start).toISOString());
      }
      if (this.next.createFailure === 'reject') {
        this.next.createFailure = undefined;
        return error(400, 'Invalid booking');
      }
      if (this.next.createFailure === 'server-error') {
        this.next.createFailure = undefined;
        return this.send(res, 500, { status: 'error' });
      }
      const free = this.slots(new Date(start), new Date(start)).hasOwnProperty(
        localDate(new Date(start), this.options.timeZone),
      );
      if (!free)
        return error(400, 'User either already has booking at this time or is not available');
      const booking: Booking = {
        uid: `sim_${randomUUID()}`,
        status: this.options.initialStatus,
        start: new Date(start).toISOString(),
        end: new Date(start + this.options.length * 60000).toISOString(),
        eventTypeId: this.options.eventTypeId,
        attendees: [input.attendee],
        bookingFieldsResponses: input.bookingFieldsResponses,
        metadata: input.metadata ?? {},
      };
      this.bookings.set(booking.uid, booking);
      if (this.next.createFailure === 'timeout-after-create') {
        this.next.createFailure = undefined;
        req.socket.destroy();
        return;
      }
      return this.send(res, 201, { status: 'success', data: booking });
    }

    if (req.method === 'GET' && path === '/bookings') {
      if (version !== CAL_VERSIONS.listBookings) return error(400, 'Unsupported cal-api-version');
      const email = url.searchParams.get('attendeeEmail');
      const data = [...this.bookings.values()].filter(
        (b) => !email || b.attendees.some((a) => a.email === email),
      );
      return this.send(res, 200, {
        status: 'success',
        data,
        pagination: { nextCursor: null, hasMore: false },
      });
    }

    const match = path.match(/^\/bookings\/([^/]+)(?:\/(cancel|reschedule|confirm))?$/);
    if (match) {
      if (version !== CAL_VERSIONS.bookings) return error(400, 'Unsupported cal-api-version');
      const booking = this.bookings.get(decodeURIComponent(match[1]));
      if (!booking) return error(404, 'Booking not found');
      const action = match[2];
      if (req.method === 'GET' && !action)
        return this.send(res, 200, { status: 'success', data: booking });
      if (req.method === 'POST' && action === 'cancel') {
        if (booking.status === 'cancelled') return error(400, 'Booking already cancelled');
        booking.status = 'cancelled';
        return this.send(res, 200, { status: 'success', data: booking });
      }
      if (req.method === 'POST' && action === 'confirm') {
        booking.status = 'accepted';
        return this.send(res, 200, { status: 'success', data: booking });
      }
      if (req.method === 'POST' && action === 'reschedule') {
        const input = await this.body(req);
        const start = Date.parse(input.start);
        if (this.taken(start, booking.uid))
          return error(400, 'User either already has booking at this time or is not available');
        const next: Booking = {
          ...booking,
          uid: `sim_${randomUUID()}`,
          status: this.options.initialStatus,
          start: new Date(start).toISOString(),
          end: new Date(start + this.options.length * 60000).toISOString(),
          rescheduledFromUid: booking.uid,
        };
        booking.status = 'cancelled';
        booking.rescheduledToUid = next.uid;
        this.bookings.set(next.uid, next);
        return this.send(res, 201, { status: 'success', data: next });
      }
    }
    return error(404, 'Not found');
  }
}

// Uso manual: pnpm --filter @instafix/api cal:simulator  (puerto 3999)
if (process.argv[1]?.endsWith('cal-simulator.ts')) {
  const simulator = new CalSimulator({
    eventTypeId: Number(process.env.CAL_SIMULATOR_EVENT_TYPE_ID || 4242),
    apiKey: process.env.CAL_SIMULATOR_API_KEY || 'cal_test_simulator',
    // Por defecto imita el evento real: 120 minutos y confirmación inmediata.
    length: Number(process.env.CAL_SIMULATOR_LENGTH || 120),
    initialStatus: process.env.CAL_SIMULATOR_STATUS === 'pending' ? 'pending' : 'accepted',
    hours: [9, 19],
  });
  void simulator.start(Number(process.env.CAL_SIMULATOR_PORT || 3999)).then((s) => {
    console.log(`Simulador Cal.com en ${s.url} (sin datos reales)`);
  });
}
