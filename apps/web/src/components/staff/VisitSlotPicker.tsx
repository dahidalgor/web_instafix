import { useCallback, useState } from 'react';
import { ScheduleStep, type FetchAvailability } from '../../features/booking/ScheduleStep';
import { api, ApiError } from '../../lib/api';

/**
 * El mismo calendario de la reserva, con solo los horarios a los que se puede mover esta visita
 * (las mismas reglas que valida el servidor al guardar). Lo usan la propuesta de horario del
 * técnico y el cambio de fecha de administración.
 */
export function VisitSlotPicker({
  appointmentId,
  purpose,
  technicianId,
  value,
  onChange,
}: {
  appointmentId: string;
  purpose: 'proposal' | 'handover' | 'move';
  /** Cambio de fecha manteniendo al técnico: también debe estar libre para él. */
  technicianId?: string | null;
  /** Inicio elegido (ISO) o null. */
  value: string | null;
  onChange: (start: string | null) => void;
}) {
  const [day, setDay] = useState<string | null>(null);
  const fetchAvailability = useCallback<FetchAvailability>(
    async (from, to) => {
      const query = new URLSearchParams({ from, to, purpose });
      if (technicianId) query.set('technicianId', technicianId);
      const data = await api<{ days: Record<string, string[]> }>(
        `staff/appointments/${appointmentId}/slots?${query}`,
      ).catch((e: unknown) => {
        throw new Error(
          e instanceof ApiError && e.status !== 0 && e.status < 500
            ? e.message
            : 'No pudimos consultar los horarios de la agenda. Inténtalo de nuevo.',
        );
      });
      return Object.fromEntries(
        Object.entries(data.days).map(([key, starts]) => [key, starts.map((s) => ({ start: s }))]),
      );
    },
    [appointmentId, purpose, technicianId],
  );
  return (
    <ScheduleStep
      fetchAvailability={fetchAvailability}
      selectedDay={day}
      selectedSlot={value ? { start: value } : null}
      onDayChange={setDay}
      onSlotChange={(slot) => onChange(slot?.start ?? null)}
    />
  );
}
