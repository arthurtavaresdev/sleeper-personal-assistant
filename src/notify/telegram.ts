import { config } from '../config.js';

const MAX_LEN = 4000; // limite da API é 4096

interface TgResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string; first_name?: string; username?: string }; text?: string };
}

export function telegramConfigured(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

async function call<T>(method: string, body: Record<string, unknown>, token = config.TELEGRAM_BOT_TOKEN): Promise<T> {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as TgResponse<T>;
    if (data.ok) return data.result;
    const retryAfter = data.parameters?.retry_after;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, (retryAfter ?? 2 ** attempt) * 1000));
      continue;
    }
    throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  }
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Quebra em blocos de até MAX_LEN respeitando linhas (não corta tags HTML no meio). */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > MAX_LEN && cur) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts;
}

export async function sendMessage(html: string, chatId = config.TELEGRAM_CHAT_ID): Promise<void> {
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID não configurado');
  for (const part of splitMessage(html)) {
    await call('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
}

export async function getMe(token?: string) {
  return call<{ id: number; username: string }>('getMe', {}, token);
}

export async function getUpdates(offset?: number, timeoutSec = 0, token?: string): Promise<TgUpdate[]> {
  return call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, token);
}
