import type { StaffPushStatus } from '@instafix/contracts/src/push';
import { api } from '../../lib/api';
import type { PushApi } from './push-client';

/** Endpoints del panel para los avisos push (siempre de la cuenta con sesión). */
export const pushApi: PushApi & { test(): Promise<{ delivered: number }> } = {
  status: (installationId) =>
    api<StaffPushStatus>(`staff/push?installationId=${encodeURIComponent(installationId)}`),
  subscribe: (installationId, subscription) =>
    api('staff/push/subscription', {
      method: 'PUT',
      body: JSON.stringify({ installationId, subscription }),
    }),
  unsubscribe: (installationId) =>
    api('staff/push/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ installationId }),
    }),
  test: () => api('staff/push/test', { method: 'POST' }),
};
