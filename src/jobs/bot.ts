import { config } from '../config.js';
import { withJobLock } from '../db/index.js';
import { log } from '../log.js';
import { listenOutbox } from '../notify/outbox.js';
import { escapeHtml, getUpdates, sendMessage } from '../notify/telegram.js';
import { runClaimsJob, runInjuriesJob, runLineupJob, runTradesJob, runWaiversJob, type JobOptions, type JobResult } from './analysis.js';

const HELP = [
  '<b>Sleeper Trader</b>',
  'Os comandos analisam todas as ligas configuradas.',
  '/lineup — melhor lineup da semana',
  '/waivers — oportunidades de waiver',
  '/claims — vale cobrir suas propostas pendentes?',
  '/trades [time] — ideias de troca',
  '/injuries — status de lesão do seu time',
].join('\n');

const COMMANDS: Record<string, (args: string, opts: JobOptions) => Promise<JobResult>> = {
  '/lineup': (_, o) => runLineupJob(o),
  '/waivers': (_, o) => runWaiversJob(o),
  '/claims': (_, o) => runClaimsJob(o),
  '/trades': (args, o) => runTradesJob({ ...o, partner: args || undefined }),
  '/injuries': (_, o) => runInjuriesJob(o),
};

/**
 * Daemon: envia o outbox assim que um job enfileira (LISTEN/NOTIFY) e responde
 * comandos via long polling. Só o chat configurado é atendido.
 */
export async function runBot(): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    throw new Error('Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID com pnpm cli setup antes de iniciar o bot.');
  }
  const result = await withJobLock('telegram-bot', pollBot);
  if (result === null) throw new Error('Outra instância do bot já está rodando. Use somente o serviço systemd.');
}

async function pollBot(): Promise<never> {
  await listenOutbox();
  let offset: number | undefined;
  log.info('bot do Telegram aguardando comandos');
  for (;;) {
    let updates;
    try {
      updates = await getUpdates(offset, 50);
    } catch (err) {
      log.error({ err }, 'falha no long polling; tentando de novo em 10s');
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text || String(msg.chat.id) !== config.TELEGRAM_CHAT_ID) continue;
      const [cmdRaw, ...rest] = msg.text.trim().split(/\s+/);
      const cmd = cmdRaw!.toLowerCase().replace(/@.*$/, '');
      const handler = COMMANDS[cmd];
      if (!handler) {
        await sendMessage(HELP).catch(() => {});
        continue;
      }
      await sendMessage('⏳ Calculando…').catch(() => {});
      try {
        // force: o usuário pediu explicitamente, envia mesmo se igual ao último relatório
        const res = await handler(rest.join(' '), { notify: true, force: true });
        if (!res.delivered) await sendMessage(res.text);
      } catch (err) {
        log.error({ err, cmd }, 'erro no comando');
        await sendMessage(`❌ Erro: ${escapeHtml(String(err instanceof Error ? err.message : err))}`).catch(() => {});
      }
    }
  }
}
