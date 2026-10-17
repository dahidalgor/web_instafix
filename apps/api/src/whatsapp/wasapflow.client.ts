import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProviderError } from '../integrations/provider-error';

export const BRIDGE_BASE = 'https://officialapi.wasapflow.com/bridge/v1';
export const BRIDGE_ORIGIN = 'https://officialapi.wasapflow.com';

/**
 * Error legible a partir de la respuesta de Bridge ({ error: { code, message, meta_code } }).
 * Nunca incluye la Partner Key; el texto del proveedor se recorta.
 */
export function describeBridgeError(status: number, result: unknown, key = '') {
  const error = (result as { error?: Record<string, unknown> } | null)?.error;
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const parts = [`WasapFlow HTTP ${status}`];
  if (error && typeof error === 'object') {
    if (text(error.code)) parts.push(text(error.code));
    if (text(error.meta_code))
      parts.push(
        `Meta ${text(error.meta_code)}${text(error.meta_subcode) ? `/${text(error.meta_subcode)}` : ''}`,
      );
    const message = text(error.message).replace(/\s+/g, ' ').slice(0, 200);
    if (message) parts.push(message);
  } else if (typeof (result as { message?: unknown })?.message === 'string')
    parts.push(String((result as { message: string }).message).slice(0, 200));
  const out = parts.join(' · ');
  return key ? out.split(key).join('[clave]') : out;
}

@Injectable()
export class WasapFlowClient {
  // Solo este cliente construye las peticiones Bridge. Sin redirecciones que filtren la clave.
  private async request(path: string, body?: unknown, wabaId?: string) {
    // Una barra final en el .env es habitual; no debe bloquear los envíos.
    const base = (process.env.WASAPFLOW_BASE_URL || BRIDGE_BASE).trim().replace(/\/+$/, '');
    const key = process.env.WASAPFLOW_PARTNER_KEY?.trim();
    if (base !== BRIDGE_BASE)
      throw new ProviderError(`WASAPFLOW_BASE_URL debe ser ${BRIDGE_BASE}`, 'FAILED');
    if (!key) throw new ProviderError('Falta WASAPFLOW_PARTNER_KEY', 'FAILED');
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          'x-partner-key': key,
          'Content-Type': 'application/json',
          ...(wabaId ? { 'x-waba-id': wabaId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new ProviderError(
        'Sin respuesta de WasapFlow (red o tiempo agotado); revisar antes de repetir',
        'REVIEW',
      );
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success !== true)
      throw new ProviderError(
        describeBridgeError(response.status, result, key),
        response.status === 429
          ? 'RETRY'
          : response.status >= 500 || response.ok
            ? 'REVIEW'
            : 'FAILED',
      );
    return result;
  }
  /** Clientes (WABAs) registrados en la cuenta de partner, con su estado. */
  async listClients() {
    const all: { waba_id: string; status: string; connection_mode?: string }[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const result = z
        .object({
          clients: z.array(
            z
              .object({
                waba_id: z.coerce.string(),
                status: z.string(),
                connection_mode: z.string().optional(),
              })
              .passthrough(),
          ),
          total: z.number(),
        })
        .parse(await this.request(`/clients?limit=100&offset=${offset}`));
      all.push(...result.clients);
      if (offset + 100 >= result.total) break;
    }
    return all;
  }
  async createConnectSession(state: string) {
    // El hosting se encarga de Embedded Signup y Coexistence; no se manejan tokens Meta.
    const config = await this.request('/embedded-signup/config');
    if (config.connection_mode !== 'coexistence')
      throw new ProviderError(
        'WasapFlow debe habilitar Coexistence antes de conectar el número',
        'FAILED',
      );
    const data = z
      .object({ connect_url: z.string().url(), expires_in: z.number().int().positive().max(3600) })
      .parse(await this.request('/connect/session', { display_name: 'Instafix', state }));
    const url = new URL(data.connect_url);
    if (
      url.origin !== BRIDGE_ORIGIN ||
      url.pathname !== '/bridge/connect' ||
      !url.searchParams.get('token') ||
      [...url.searchParams.keys()].some((key) => key !== 'token') ||
      data.connect_url.includes(process.env.WASAPFLOW_PARTNER_KEY!)
    )
      throw new ProviderError('WasapFlow devolvió un enlace de conexión no válido', 'FAILED');
    return data;
  }
  async verifyClient(wabaId: string) {
    // La lista verifica pertenencia al partner; el modo se exige también en el resultado del popup.
    for (let offset = 0; offset < 10000; offset += 100) {
      const result = z
        .object({
          clients: z.array(
            z.object({
              waba_id: z.string(),
              status: z.string(),
              connection_mode: z.string().optional(),
            }),
          ),
          total: z.number(),
        })
        .parse(await this.request(`/clients?limit=100&offset=${offset}`));
      const client = result.clients.find((item) => item.waba_id === wabaId);
      if (client) {
        if (
          client.status !== 'active' ||
          (client.connection_mode && client.connection_mode !== 'coexistence')
        )
          throw new ProviderError('La WABA no está activa en Coexistence', 'FAILED');
        return;
      }
      if (offset + 100 >= result.total) break;
    }
    throw new ProviderError('La WABA no pertenece a este partner', 'FAILED');
  }
  async sendTemplate(wabaId: string, to: string, name: string, language: string, params: string[]) {
    return this.messageId(
      await this.request(
        '/messages/template',
        {
          to,
          template: {
            name,
            language,
            components: [
              {
                type: 'body',
                parameters: params.map((text) => ({
                  type: 'text',
                  text: text.replace(/\s+/g, ' ').trim(),
                })),
              },
            ],
          },
        },
        wabaId,
      ),
    );
  }
  /**
   * Plantilla de categoría AUTHENTICATION con botón «Copiar código». Meta exige el código
   * como parámetro del cuerpo y del botón; siempre se envía a un teléfono, nunca a un BSUID.
   */
  async sendAuthenticationTemplate(
    wabaId: string,
    to: string,
    name: string,
    language: string,
    code: string,
  ) {
    if (!/^\d{4,8}$/.test(code)) throw new ProviderError('Código OTP inválido', 'FAILED');
    return this.messageId(
      await this.request(
        '/messages/template',
        {
          to,
          template: {
            name,
            language,
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
              },
            ],
          },
        },
        wabaId,
      ),
    );
  }
  async sendText(wabaId: string, to: string, text: string) {
    return this.messageId(
      await this.request('/messages/send', { to, text, preview_url: false }, wabaId),
    );
  }
  private messageId(result: { message_id?: unknown }) {
    if (typeof result.message_id !== 'string' || !result.message_id)
      throw new ProviderError(
        'WasapFlow no devolvió message_id; revisar antes de repetir',
        'REVIEW',
      );
    return result.message_id;
  }
}
