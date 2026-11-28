import {
  repairStatusLabels,
  repairSteps,
  type RepairOrderView,
  type RepairStatus,
} from '@instafix/contracts';
import type { ReactNode } from 'react';
import { money } from '../../lib/format';

const day = (value: string) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(value))
    .replace(/\./g, '');

/** Posición en la barra: «No se repara» y «Devuelto» se muestran sobre el paso del presupuesto. */
const stepIndex = (status: RepairStatus) => {
  const at: Partial<Record<RepairStatus, RepairStatus>> = {
    DECLINED: 'QUOTED',
    RETURNED: 'DELIVERED',
  };
  return repairSteps.findIndex((s) => s.id === (at[status] ?? status));
};

/** Barra de progreso del trabajo de taller (lo que ve el cliente). */
export function RepairProgress({ status }: { status: RepairStatus }) {
  const current = stepIndex(status);
  const declined = status === 'DECLINED' || status === 'RETURNED';
  return (
    <ol className="repair-steps" aria-label={`Estado: ${repairStatusLabels[status]}`}>
      {repairSteps.map((step, i) => (
        <li
          key={step.id}
          className={
            i < current ? 'is-done' : i === current ? (declined ? 'is-stopped' : 'is-current') : ''
          }
          aria-current={i === current ? 'step' : undefined}
        >
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Tarjeta de un equipo en taller: cliente, técnico y administración. */
export function RepairCard({
  order,
  showContact = false,
  children,
}: {
  order: RepairOrderView;
  showContact?: boolean;
  children?: ReactNode;
}) {
  return (
    <article className={`repair-card repair-${order.status}`}>
      <div className="repair-head">
        <div>
          <span className="repair-code">{order.code}</span>
          <h3>{order.device}</h3>
        </div>
        <span className="repair-status">{repairStatusLabels[order.status]}</span>
      </div>
      <RepairProgress status={order.status} />
      <dl className="repair-meta">
        {showContact && order.contactName && (
          <div>
            <dt>Cliente</dt>
            <dd>
              {order.contactName}
              {order.contactPhone ? ` · ${order.contactPhone}` : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Falla indicada</dt>
          <dd>{order.reportedFault}</dd>
        </div>
        <div>
          <dt>Cómo se recibió</dt>
          <dd>{order.intakeCondition}</dd>
        </div>
        <div>
          <dt>Recibido</dt>
          <dd>
            {day(order.createdAt)}
            {order.receivedBy ? ` · ${order.receivedBy}` : ''}
          </dd>
        </div>
        {order.quoteMinor != null && (
          <div>
            <dt>Presupuesto</dt>
            <dd>
              <strong>{money(order.quoteMinor)}</strong>
              {order.quoteNote ? ` · ${order.quoteNote}` : ''}
              {order.quoteAnswer &&
                ` · ${order.quoteAnswer === 'APPROVED' ? 'aprobado' : 'no aceptado'}${
                  order.quoteAnsweredVia === 'WHATSAPP'
                    ? ' por WhatsApp'
                    : order.quoteAnsweredVia === 'ACCOUNT'
                      ? ' en la cuenta'
                      : ''
                }`}
            </dd>
          </div>
        )}
        {order.deliveredAt && (
          <div>
            <dt>{order.status === 'RETURNED' ? 'Devuelto' : 'Entregado'}</dt>
            <dd>
              {day(order.deliveredAt)}
              {order.finalMinor ? ` · ${money(order.finalMinor)}` : ''}
            </dd>
          </div>
        )}
      </dl>
      {children && <div className="repair-actions">{children}</div>}
    </article>
  );
}
