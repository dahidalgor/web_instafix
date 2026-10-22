import type { StaffDeliveryChannel, StaffPushPayload } from '@instafix/contracts';

/**
 * Canal de entrega de avisos al equipo. El servicio de avisos decide QUIÉN recibe QUÉ; el canal
 * solo sabe entregar a los dispositivos de un usuario. Web Push es el único canal hoy; una app
 * nativa añadiría p. ej. un `ApnsChannel` o `FcmChannel` con sus propios tokens (otra tabla),
 * sin tocar la lógica de citas ni las reglas de destinatarios.
 */
export interface StaffChannel {
  readonly name: StaffDeliveryChannel;
  /** false = falta configuración: los avisos esperan en la bandeja, no se pierden. */
  configured(): boolean;
  deliver(userId: string, payload: StaffPushPayload): Promise<ChannelOutcome>;
}

/**
 * Resultado agregado de los dispositivos de un usuario:
 * - SENT: al menos un dispositivo lo aceptó (no se reintenta: evitaría duplicados).
 * - NO_DEVICES: no hay dispositivos activos (o todos caducaron y se desactivaron).
 * - RETRY: fallo temporal del proveedor en todos los dispositivos.
 * - FAILED: el proveedor rechazó el aviso de forma definitiva.
 */
export type ChannelOutcome =
  | { status: 'SENT'; delivered: number; failed: number }
  | { status: 'NO_DEVICES'; reason: string }
  | { status: 'RETRY'; reason: string }
  | { status: 'FAILED'; reason: string };
