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

/**
 * Administración → Horarios → Equipo: la semana de cada técnico y administrador (horas ocupadas
 * y visitas confirmadas). Sirve para ver quién puede atender y cuándo.
 */
export function TeamSchedule() {
  const [week, setWeek] = useState(() => weekStartOf(todayInEcuador()));
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [person, setPerson] = useState('all');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<{ members: Member[] }>(`admin/staff/schedule?week=${week}`, { signal: controller.signal })
      .then((res) => {
        setMembers(res.members);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'No se pudo cargar el horario del equipo.');
      })
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [week]);

  const colors = useMemo(
    () => new Map((members ?? []).map((m, i) => [m.id, palette[i % palette.length]])),
    [members],
  );
  const shown = useMemo(
    () => (members ?? []).filter((m) => person === 'all' || m.id === person),
    [members, person],
  );
  const items = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const all = person === 'all';
    return shown.flatMap((m): CalendarItem[] => {
      const color = colors.get(m.id);
      const who = firstName(m.name);
      const blocks = days.flatMap((day) =>
        blocksOn(m.blocks, day).map((block) => ({
          id: `${m.id}:${block.id}:${day}`,
          day,
          startMinute: block.startMinute,
          endMinute: block.endMinute,
          title: all ? who : block.label,
          detail: all ? `${block.label} · ${m.name}` : m.name,
          kind: 'busy' as const,
          color,
        })),
      );
      const visits = m.visits.flatMap((visit) =>
        localSpans(new Date(visit.startsAt), new Date(visit.endsAt))
          .filter((span) => days.includes(span.day))
          .map((span) => ({
            ...span,
            id: `${m.id}:${visit.id}:${span.day}`,
            title: all ? who : `Visita · ${customerFirstName(visit.contactName) ?? 'cliente'}`,
            detail: `Visita de ${customerFirstName(visit.contactName) ?? 'un cliente'} (${visit.title}) · ${m.name}`,
            kind: 'visit' as const,
            color,
          })),
      );
      return [...blocks, ...visits];
    });
  }, [shown, colors, week, person]);

  return (
    <section className="settings-card team-schedule" aria-labelledby="team-week">
      <div className="settings-card-head">
        <h2 id="team-week">Semana del equipo</h2>
        <p>
          Horas ocupadas (rayado) y visitas confirmadas (sólido) de cada persona. Una solicitud solo
          se ofrece en horarios en que alguien está libre.
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
