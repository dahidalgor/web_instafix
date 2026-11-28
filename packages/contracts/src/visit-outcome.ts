import { z } from 'zod';

/**
 * Resultado de una visita al completarla. El técnico siempre elige uno:
 *  - CHARGED: se cobraron servicios (al menos uno con valor).
 *  - VISIT_FEE: solo la visita técnica (valor fijo), p. ej. diagnóstico sin reparación.
 *  - NO_CHARGE: no se cobró nada; motivo y explicación obligatorios, y administración la revisa.
 */
export const visitOutcomes = ['CHARGED', 'VISIT_FEE', 'NO_CHARGE'] as const;
export type VisitOutcome = (typeof visitOutcomes)[number];

/** Cargo fijo por visita técnica (en centavos de USD). */
export const VISIT_FEE = { name: 'Visita técnica', priceMinor: 500 } as const;

export const noChargeReasons = {
  INCOMPATIBLE_PART: 'El repuesto o accesorio no era compatible',
  DIFFERENT_FAULT: 'La falla era distinta: el equipo se lleva al taller',
  BUDGET_DECLINED: 'El cliente no aceptó el presupuesto',
  CUSTOMER_ABSENT: 'El cliente no estaba o no abrió',
  WARRANTY: 'Garantía de un trabajo anterior',
  OTHER: 'Otro motivo',
} as const;
export type NoChargeReason = keyof typeof noChargeReasons;

export const visitOutcomeLabels: Record<VisitOutcome, string> = {
  CHARGED: 'Se cobró',
  VISIT_FEE: 'Solo visita técnica',
  NO_CHARGE: 'Sin cobro',
};

/** Revisión de administración de una visita sin cobro. */
export const noChargeReviewSchema = z
  .object({ decision: z.enum(['APPROVED', 'FLAGGED']) })
  .strict();
