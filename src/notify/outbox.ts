import { createHash } from 'node:crypto';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { sendMessage, telegramConfigured } from './telegram.js';

/**
 * Enfileira uma mensagem. A dedupe_key combina tipo, semana e hash do conteúdo:
 * a mesma sugestão não é reenviada; uma sugestão diferente gera mensagem nova.
 */
export async function enqueue(kind: string, scope: string, body: string, opts: { dedupeByScope?: boolean } = {}): Promise<boolean> {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const key = opts.dedupeByScope ? `${kind}:${scope}` : `${kind}:${scope}:${hash}`;
  const rows = await sql`
    INSERT INTO app.outbox (kind, dedupe_key, body) VALUES (${kind}, ${key}, ${body})
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

/** Envia pendentes. SKIP LOCKED permite job e daemon drenarem ao mesmo tempo sem duplicar. */
export async function drainOutbox(): Promise<number> {
  if (!telegramConfigured()) {
    log.warn('Telegram não configurado; mensagens ficam pendentes no outbox');
    return 0;
  }
  let sent = 0;
  for (;;) {
    const done = await sql.begin(async (tx) => {
      const [msg] = await tx`
        SELECT id, body FROM app.outbox
        WHERE sent_at IS NULL AND attempts < 5
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!msg) return true;
      try {
        await sendMessage(msg.body as string);
        await tx`UPDATE app.outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = ${msg.id}`;
        sent++;
      } catch (err) {
        log.error({ err, id: msg.id }, 'falha ao enviar mensagem');
        await tx`UPDATE app.outbox SET attempts = attempts + 1, last_error = ${String(err)} WHERE id = ${msg.id}`;
        // Interrompe: provavelmente Telegram fora do ar; tenta na próxima drenagem
        return true;
      }
      return false;
    });
    if (done) return sent;
  }
}

/** Escuta o canal 'outbox' (trigger pg_notify) e drena a cada nova mensagem. */
export async function listenOutbox(): Promise<void> {
  await drainOutbox();
  await sql.listen('outbox', () => {
    drainOutbox().catch((err) => log.error({ err }, 'erro ao drenar outbox'));
  });
  log.info('escutando novas mensagens do outbox');
}
