import {
  addDays,
  blocksOn,
  customerFirstName,
  localSpans,
  weekStartOf,
  type BusyBlock,
} from '@instafix/contracts';
import { useEffect, useMemo, useState } from 'react';
import {
  todayInEcuador,
  WeekCalendar,
  type CalendarItem,
} from '../../components/schedule/WeekCalendar';
import { api } from '../../lib/api';
import { TechnicianSchedule } from '../technician/TechnicianSchedule';

type Member = {
  id: string;
  name: string;
  role: 'ADMIN' | 'TECHNICIAN';
  blocks: BusyBlock[];
  visits: { id: string; startsAt: string; endsAt: string; contactName: string; title: string }[];
};

/** Un color por persona, legible en claro y oscuro. */
const palette = [
  '#a00d68',
  '#2563eb',
  '#0f8a5f',
  '#c2410c',
  '#7c3aed',
  '#0e7490',
  '#b45309',
  '#be185d',
];
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** La semana del equipo (o de una persona) desde el lunes `week`. */
function useStaffWeek(week: string, { userId, busy }: { userId?: string; busy: boolean }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ week, busy: busy ? '1' : '0' });
    if (userId) query.set('userId', userId);
    setLoading(true);
    api<{ members: Member[] }>(`admin/staff/schedule?${query}`, { signal: controller.signal })
      .then((res) => {
        setMembers(res.members);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'No se pudo cargar el horario.');
      })
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [week, userId, busy]);
  return { members, loading, error };
}

/** Bloques del calendario de una persona: horas ocupadas (rayado) y visitas (sólido). */
function memberItems(
  m: Member,
  week: string,
  { color, team, busy, visits }: { color?: string; team: boolean; busy: boolean; visits: boolean },
): CalendarItem[] {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const who = firstName(m.name);
  const blocks = busy
    ? days.flatMap((day) =>
        blocksOn(m.blocks, day).map((block) => ({
          id: `${m.id}:${block.id}:${day}`,
          day,
          startMinute: block.startMinute,
          endMinute: block.endMinute,
          title: block.label,
          detail: m.name,
          kind: 'busy' as const,
          color,
        })),
      )
    : [];
  const appointments = visits
    ? m.visits.flatMap((visit) =>
        localSpans(new Date(visit.startsAt), new Date(visit.endsAt))
          .filter((span) => days.includes(span.day))
          .map((span) => ({
            ...span,
            id: `${m.id}:${visit.id}:${span.day}`,
            title: team ? who : `Visita · ${customerFirstName(visit.contactName) ?? 'cliente'}`,
            detail: `Visita de ${customerFirstName(visit.contactName) ?? 'un cliente'} (${visit.title}) · ${m.name}`,
            kind: 'visit' as const,
            color,
          })),
      )
    : [];
  return [...blocks, ...appointments];
}

/**
 * Administración → Horarios → Equipo: las visitas confirmadas de cada técnico y administrador
 * en la semana. Los horarios ocupados se ven en Equipo técnico → «Ver horarios».
 */
export function TeamSchedule() {
  const [week, setWeek] = useState(() => weekStartOf(todayInEcuador()));
  const [person, setPerson] = useState('all');
  const { members, loading, error } = useStaffWeek(week, { busy: false });

  const colors = useMemo(
    () => new Map((members ?? []).map((m, i) => [m.id, palette[i % palette.length]])),
    [members],
  );
  const shown = useMemo(
    () => (members ?? []).filter((m) => person === 'all' || m.id === person),
    [members, person],
  );
  const items = useMemo(
    () =>
      shown.flatMap((m) =>
        memberItems(m, week, {
          color: colors.get(m.id),
          team: person === 'all',
          busy: false,
          visits: true,
        }),
      ),
    [shown, colors, week, person],
  );

  return (
    <section className="settings-card team-schedule" aria-labelledby="team-week">
      <div className="settings-card-head">
        <h2 id="team-week">Citas del equipo</h2>
        <p>
          Visitas confirmadas de cada persona en la semana. Los horarios ocupados se revisan en
          Equipo técnico → «Ver horarios».
        </p>
      </div>
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      {members && (
        <label className="team-schedule-filter">
          Ver
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="all">Todo el equipo</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.role === 'ADMIN' ? ' (administración)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <WeekCalendar
        weekStart={week}
        items={items}
        onWeekChange={(day) => setWeek(weekStartOf(day))}
        loading={loading}
        legend={
          shown.length ? (
            shown.map((m) => (
              <span key={m.id} className="week-legend-item">
                <i
                  className="week-swatch"
                  style={{ ['--item-color' as string]: colors.get(m.id) }}
                />
                {m.name}
              </span>
            ))
          ) : members ? (
            <span>No hay técnicos ni administradores activos.</span>
          ) : null
        }
      />
    </section>
  );
}

/**
 * Equipo técnico → «Ver horarios»: la semana de una persona con sus horarios ocupados y sus
 * citas; cada capa se puede ocultar.
 */
export function MemberSchedule({ userId, name }: { userId: string; name: string }) {
  const [week, setWeek] = useState(() => weekStartOf(todayInEcuador()));
  const [showBusy, setShowBusy] = useState(true);
  const [showVisits, setShowVisits] = useState(true);
  const { members, loading, error } = useStaffWeek(week, { userId, busy: true });
  const member = members?.[0];
  const items = useMemo(
    () =>
      member ? memberItems(member, week, { team: false, busy: showBusy, visits: showVisits }) : [],
    [member, week, showBusy, showVisits],
  );
  const hidden = !showBusy && !showVisits;
  return (
    <div className="member-schedule" aria-label={`Horarios de ${name}`}>
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      <div className="member-schedule-toggles" role="group" aria-label="Qué mostrar">
        <label>
          <input
            type="checkbox"
            checked={showBusy}
            onChange={(e) => setShowBusy(e.target.checked)}
          />
          <i className="week-swatch is-busy" aria-hidden="true" /> Horarios ocupados
        </label>
        <label>
          <input
            type="checkbox"
            checked={showVisits}
            onChange={(e) => setShowVisits(e.target.checked)}
          />
          <i className="week-swatch is-visit" aria-hidden="true" /> Horarios de citas
        </label>
      </div>
      <WeekCalendar
        weekStart={week}
        items={items}
        onWeekChange={(day) => setWeek(weekStartOf(day))}
        loading={loading}
        legend={
          hidden ? (
            <span>Activa al menos una de las dos opciones para ver el horario.</span>
          ) : member && !loading && !items.length ? (
            <span>Nada registrado esta semana.</span>
          ) : null
        }
      />
    </div>
  );
}

/** Administración → Horarios: la semana del equipo o los horarios propios. */
export function AdminSchedule() {
  const [view, setView] = useState<'team' | 'mine'>('team');
  return (
    <div className="settings-stack">
      <div className="account-tabs" role="group" aria-label="Horarios">
        <button type="button" aria-pressed={view === 'team'} onClick={() => setView('team')}>
          Equipo
        </button>
        <button type="button" aria-pressed={view === 'mine'} onClick={() => setView('mine')}>
          Mis horarios
        </button>
      </div>
      {view === 'team' ? <TeamSchedule /> : <TechnicianSchedule />}
    </div>
  );
}
