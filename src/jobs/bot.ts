import { config } from '../config.js';
import { withJobLock } from '../db/index.js';
import { log } from '../log.js';
import { connectionNotifier } from '../notify/connection.js';
import { listenOutbox } from '../notify/outbox.js';
import { downloadFile, escapeHtml, getUpdates, MAX_DOWNLOAD_BYTES, messageImage, sendMessage } from '../notify/telegram.js';
import { runInboxJob, runClaimsJob, runInjuriesJob, runLineupJob, runTradeImageJob, runTradesJob, runWaiversJob, type JobOptions, type JobResult } from './analysis.js';

const HELP = [
  '<b>Sleeper Personal Assistant</b>',
  'Os comandos analisam todas as ligas configuradas.',
  '/lineup — melhor lineup da semana',
  '/waivers — oportunidades de waiver',
  '/claims — vale cobrir suas propostas pendentes?',
  '/trades [time] — ideias de troca',
  '/inbox — propostas de trade recebidas e avaliação',
  '/injuries — status de lesão do seu time',
  '📷 Envie um print de trade do Sleeper para avaliar a troca (legenda opcional com o nome da liga)',
].join('\n');

const COMMANDS: Record<string, (args: string, opts: JobOptions) => Promise<JobResult>> = {
  '/lineup': (_, o) => runLineupJob(o),
  '/waivers': (_, o) => runWaiversJob(o),
  '/claims': (_, o) => runClaimsJob(o),
  '/inbox': (_, o) => runInboxJob(o),
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
  const connection = connectionNotifier(sendMessage);
  log.info('bot do Telegram aguardando comandos');
  for (;;) {
    let updates;
    try {
      updates = await getUpdates(offset, connection.pending ? 0 : 50);
      await connection.connected();
    } catch (err) {
      connection.disconnected();
      log.error({ err }, 'falha no long polling; tentando de novo em 10s');
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || String(msg.chat.id) !== config.TELEGRAM_CHAT_ID) continue;
      const image = messageImage(msg);
      if (image) {
        if ((image.size ?? 0) > MAX_DOWNLOAD_BYTES) {
          await sendMessage('❌ Imagem acima de 20 MB.').catch(() => {});
          continue;
        }
        await sendMessage('⏳ Lendo a imagem…').catch(() => {});
        await respond('imagem', async (opts) => {
          const file = await downloadFile(image.fileId);
          return runTradeImageJob({ ...opts, image: file.data, mediaType: image.mimeType, caption: msg.caption });
        });
        continue;
      }
      if (!msg.text) continue;
      const [cmdRaw, ...rest] = msg.text.trim().split(/\s+/);
      const cmd = cmdRaw!.toLowerCase().replace(/@.*$/, '');
      const handler = COMMANDS[cmd];
      if (!handler) {
        await sendMessage(HELP).catch(() => {});
        continue;
      }
      await sendMessage('⏳ Calculando…').catch(() => {});
      await respond(cmd, (opts) => handler(rest.join(' '), opts));
    }
  }
}

async function respond(cmd: string, run: (opts: JobOptions) => Promise<JobResult>): Promise<void> {
  try {
    // force: o usuário pediu explicitamente, envia mesmo se igual ao último relatório
    const res = await run({ notify: true, force: true });
    if (!res.delivered) await sendMessage(res.text);
  } catch (err) {
    log.error({ err, cmd }, 'erro no comando');
    await sendMessage(`❌ Erro: ${escapeHtml(String(err instanceof Error ? err.message : err))}`).catch(() => {});
  }
}
