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
  message?: {
    message_id: number;
    chat: { id: number; type: string; first_name?: string; username?: string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; width: number; height: number; file_size?: number }[];
    document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  };
}

/** Limite de download de arquivos pela Bot API. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

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

/** Imagem anexada à mensagem: maior resolução de uma foto, ou documento image/*. */
export function messageImage(msg: NonNullable<TgUpdate['message']>): { fileId: string; mimeType?: string; size?: number } | null {
  const photo = msg.photo?.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  if (photo) return { fileId: photo.file_id, mimeType: 'image/jpeg', size: photo.file_size };
  if (msg.document?.mime_type?.startsWith('image/')) {
    return { fileId: msg.document.file_id, mimeType: msg.document.mime_type, size: msg.document.file_size };
  }
  return null;
}

/** Código do erro de rede (ex.: ETIMEDOUT), sem a URL — que contém o token. */
function networkCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; errors?: { code?: unknown }[] } })?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : '';
}

/**
 * Baixa um arquivo enviado ao bot. A URL contém o token e nunca vai para logs ou erros.
 * Falhas de rede e HTTP 5xx são repetidas: são operações de leitura, idempotentes.
 */
export async function downloadFile(
  fileId: string,
  token = config.TELEGRAM_BOT_TOKEN,
  delayMs = (attempt: number) => 2 ** attempt * 1000,
): Promise<{ data: Buffer; path: string }> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const file = await call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, token);
      if (!file.file_path) throw new Error('Telegram não disponibilizou o arquivo.');
      if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error('Arquivo acima de 20 MB.');
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (res.ok) return { data: Buffer.from(await res.arrayBuffer()), path: file.file_path };
      if (res.status < 500) throw new Error(`Falha ao baixar a imagem do Telegram (HTTP ${res.status}).`);
      failure = `Falha ao baixar a imagem do Telegram (HTTP ${res.status}).`;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      failure = `Falha de rede ao baixar a imagem do Telegram${networkCode(err)}.`;
    }
    if (attempt >= 4) throw new Error(`${failure} Tente reenviar.`);
    await new Promise((r) => setTimeout(r, delayMs(attempt)));
  }
}
