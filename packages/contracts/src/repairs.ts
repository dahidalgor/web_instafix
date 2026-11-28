import { z } from 'zod';

/**
 * Trabajos de taller: un equipo que el técnico se lleva desde una visita. Recorrido normal:
 * RECEIVED → DIAGNOSING → QUOTED → APPROVED → READY → DELIVERED. Si el cliente no acepta el
 * presupuesto: QUOTED → DECLINED → RETURNED (se devuelve sin reparar).
 */
export const repairStatuses = [
  'RECEIVED',
  'DIAGNOSING',
  'QUOTED',
  'APPROVED',
  'DECLINED',
  'READY',
  'DELIVERED',
  'RETURNED',
] as const;
export type RepairStatus = (typeof repairStatuses)[number];

export const repairStatusLabels: Record<RepairStatus, string> = {
  RECEIVED: 'Recibido',
  DIAGNOSING: 'En diagnóstico',
  QUOTED: 'Presupuesto enviado',
  APPROVED: 'En reparación',
  DECLINED: 'No se repara: por devolver',
  READY: 'Listo para entregar',
  DELIVERED: 'Entregado',
  RETURNED: 'Devuelto sin reparar',
};

/** Pasos que ve el cliente (barra de progreso). */
export const repairSteps: { id: RepairStatus; label: string }[] = [
  { id: 'RECEIVED', label: 'Recibido' },
  { id: 'DIAGNOSING', label: 'Diagnóstico' },
  { id: 'QUOTED', label: 'Presupuesto' },
  { id: 'APPROVED', label: 'Reparación' },
  { id: 'READY', label: 'Listo' },
  { id: 'DELIVERED', label: 'Entregado' },
];

/** Sigue en manos de Instafix. */
export const repairInShop = (status: string) => !['DELIVERED', 'RETURNED'].includes(status);

/** «T-0042». */
export const repairCode = (code: number) => `T-${String(code).padStart(4, '0')}`;

/** El técnico registra un equipo que se lleva al taller desde la visita. */
export const repairIntakeSchema = z
  .object({
    device: z.string().trim().min(2, 'Indica el equipo').max(80),
    reportedFault: z.string().trim().min(3, 'Indica la falla').max(300),
    intakeCondition: z.string().trim().min(3, 'Describe cómo lo recibes').max(500),
  })
  .strict();

/** Administración: presupuesto (en centavos) y detalle para el cliente. */
export const repairQuoteSchema = z
  .object({
    quoteMinor: z.number().int().min(0).max(10_000_00),
    quoteNote: z.string().trim().max(200).optional().default(''),
  })
  .strict();

/** Administración: avanzar el estado (el presupuesto y la entrega tienen sus propias acciones). */
export const repairStatusSchema = z
  .object({ status: z.enum(['DIAGNOSING', 'APPROVED', 'DECLINED', 'READY']) })
  .strict();

/** Administración: entregar (con lo cobrado) o devolver sin reparar. */
export const repairDeliverSchema = z
  .object({
    returned: z.boolean().default(false),
    finalMinor: z.number().int().min(0).max(10_000_00),
  })
  .strict();

/** Cliente (o administración en su nombre): respuesta al presupuesto. */
export const repairAnswerSchema = z.object({ answer: z.enum(['APPROVED', 'DECLINED']) }).strict();

/** Vista de un trabajo de taller (cliente, técnico y administración). */
export type RepairOrderView = {
  id: string;
  code: string;
  appointmentId: string;
  visitStartsAt: string;
  device: string;
  reportedFault: string;
  intakeCondition: string;
  status: RepairStatus;
  quoteMinor: number | null;
  quoteNote: string | null;
  quotedAt: string | null;
  quoteAnswer: 'APPROVED' | 'DECLINED' | null;
  quoteAnsweredVia: 'WHATSAPP' | 'ACCOUNT' | 'ADMIN' | null;
  finalMinor: number | null;
  deliveredAt: string | null;
  createdAt: string;
  receivedBy: string | null;
  /** Solo administración. */
  contactName?: string;
  contactPhone?: string;
};
