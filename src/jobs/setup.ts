import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { config } from '../config.js';
import { sleeper } from '../sleeper/client.js';
import { getMe, getUpdates, sendMessage } from '../notify/telegram.js';

const ENV_PATH = new URL('../../.env', import.meta.url);

/** Atualiza (ou acrescenta) chaves no .env preservando o resto do arquivo. */
export async function setEnvVars(vars: Record<string, string>): Promise<void> {
  let text = await readFile(ENV_PATH, 'utf8').catch(() => '');
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
    process.env[k] = v;
  }
  await writeFile(ENV_PATH, text);
}

export async function runSetup(opts: { username?: string; league?: string }): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = opts.username ?? (config.SLEEPER_USERNAME || (await rl.question('Usuário do Sleeper: ')).trim());
    const user = await sleeper.user(username);
    const state = await sleeper.state();
    const leagues = await sleeper.userLeagues(user.user_id, state.season);
    if (leagues.length === 0) throw new Error(`${username} não tem ligas em ${state.season}`);

    let leagueId = opts.league;
    if (!leagueId) {
      leagues.forEach((l, i) => console.log(`  [${i + 1}] ${l.name} (${l.total_rosters} times, ${l.league_id})`));
      const picks = leagues.length === 1 ? '1' : await rl.question('Escolha as ligas (ex.: 1,2): ');
      const chosen = picks.split(',').map(x => leagues[Number(x.trim()) - 1]?.league_id);
      if (chosen.some(id => !id)) throw new Error('Opção inválida');
      leagueId = [...new Set(chosen)].join(',');
      if (!leagueId) throw new Error('Opção inválida');
    }
    await setEnvVars({ SLEEPER_USERNAME: username, LEAGUE_ID: leagueId.split(',')[0]!, LEAGUE_IDS: leagueId });
    console.log(`✔ Liga configurada: ${leagues.find((l) => l.league_id === leagueId)?.name ?? leagueId}`);

    const token = config.TELEGRAM_BOT_TOKEN || (await rl.question('Token do bot do Telegram (@BotFather, Enter para pular): ')).trim();
    if (!token) {
      console.log('Telegram não configurado — rode setup de novo quando tiver o token.');
      return;
    }
    const bot = await getMe(token);
    await setEnvVars({ TELEGRAM_BOT_TOKEN: token });
    console.log(`✔ Bot @${bot.username}`);

    let chatId = config.TELEGRAM_CHAT_ID;
    if (!chatId) {
      await rl.question(`Abra t.me/${bot.username}, envie /start e pressione Enter... `);
      const updates = await getUpdates(undefined, 0, token);
      const chat = updates.reverse().find((u) => u.message?.chat.type === 'private')?.message?.chat;
      if (!chat) throw new Error('Nenhuma mensagem encontrada. Envie /start para o bot e rode setup de novo.');
      chatId = String(chat.id);
      await setEnvVars({ TELEGRAM_CHAT_ID: chatId });
    }
    await sendMessage('✅ <b>Sleeper Personal Assistant</b> conectado! Você vai receber lineup, waivers e trocas por aqui.', chatId);
    console.log(`✔ Mensagem de teste enviada (chat ${chatId})`);
  } finally {
    rl.close();
  }
}
