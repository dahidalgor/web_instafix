import type { RepairOrder } from '@prisma/client';
import { repairCode } from '@instafix/contracts';
import type { TemplateVariables } from '../whatsapp/provider';

const money = (minor: number) =>
  new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(minor / 100);

/** Valores del WhatsApp del presupuesto: equipo, número de orden y valor. */
export function repairVariables(order: RepairOrder): TemplateVariables {
  return {
    equipo: order.device.slice(0, 80),
    orden: repairCode(order.code),
    valor: money(order.quoteMinor ?? 0),
  };
}
