import type { AccountUser } from '@instafix/contracts';
import { useState } from 'react';
import { StaffShell } from '../../components/staff/StaffShell';
import { StaffSettings } from '../staff/StaffSettings';
import { isTechTab, techGroups, techPrimary, techViews, type TechAppTab } from './technician-nav';
import { TechnicianPanel, type TechnicianCounts } from './TechnicianPanel';

const TAB_KEY = 'instafix:tech-tab';
function savedTab(): TechAppTab {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return isTechTab(value) ? value : 'hoy';
  } catch {
    return 'hoy';
  }
}

/**
 * Panel de técnicos como app: barra inferior en el móvil (Hoy, Próximas, Pendientes, Historial,
 * Ajustes) y barra lateral en escritorio, con la misma estructura que Administración.
 */
export function TechnicianApp({
  user,
  onUser,
  onLogout,
  focusId,
  onFocused,
}: {
  user: AccountUser;
  onUser: (user: AccountUser) => void;
  onLogout: () => void;
  focusId: string | null;
  onFocused: () => void;
}) {
  const [tab, setTabState] = useState<TechAppTab>(savedTab);
  const [counts, setCounts] = useState<TechnicianCounts | null>(null);
  const setTab = (next: TechAppTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Sin almacenamiento: la ventana no se recuerda.
    }
  };
  // Una notificación abre la cita sobre la lista de visitas, nunca sobre Ajustes.
  const view = tab === 'ajustes' ? (focusId ? 'hoy' : null) : tab;
  return (
    <StaffShell
      area="Técnicos"
      user={user}
      groups={techGroups}
      primary={techPrimary}
      tab={view ?? 'ajustes'}
      onSelect={setTab}
      onLogout={onLogout}
      accountTab="ajustes"
      badges={counts ? { hoy: counts.today, pendientes: counts.pending } : {}}
    >
      {view ? (
        <TechnicianPanel
          user={user}
          embedded
          view={techViews[view]}
          onCounts={setCounts}
          focusId={focusId}
          onFocused={() => {
            if (tab === 'ajustes') setTab('hoy');
            onFocused();
          }}
        />
      ) : (
        <StaffSettings user={user} onUser={onUser} onLogout={onLogout} />
      )}
    </StaffShell>
  );
}
