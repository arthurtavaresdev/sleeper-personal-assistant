import { Command } from 'commander';
import { sql } from './db/index.js';
import { log } from './log.js';
import { requireLeagueId } from './config.js';
import { loadLeague } from './league/settings.js';
import { runInjuriesJob, runLineupJob, runTradesJob, runWaiversJob, type JobResult } from './jobs/analysis.js';
import { runBacktest } from './jobs/backtest.js';
import { runBot } from './jobs/bot.js';
import { runSetup } from './jobs/setup.js';
import { runSync } from './jobs/sync.js';

/** HTML do Telegram → texto para o terminal. */
function toTerminal(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseWeeks(spec: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!m) throw new Error(`Semanas inválidas: ${spec} (use 3 ou 2-6)`);
  const a = Number(m[1]);
  const b = Number(m[2] ?? m[1]);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const print = (r: JobResult) => console.log(toTerminal(r.text));

const program = new Command('sleeper-trader').description('Assistente de fantasy football para ligas do Sleeper');

program
  .command('setup')
  .description('configura usuário, liga e bot do Telegram')
  .option('-u, --username <name>', 'usuário do Sleeper')
  .option('-l, --league <id>', 'ID da liga')
  .action((o) => runSetup(o));

program
  .command('sync')
  .description('baixa dados do Sleeper e do nflverse e recalcula features')
  .option('-f, --force', 'ignora o cache')
  .action(async (o) => {
    const r = await runSync({ force: o.force });
    console.log(`Sincronizado: temporada ${r.season}, semana ${r.week}`);
  });

const week = (v: string) => Number(v);

program
  .command('lineup')
  .description('melhor lineup da semana')
  .option('-w, --week <n>', 'semana', week)
  .option('-n, --notify', 'envia no Telegram')
  .action(async (o) => print(await runLineupJob(o)));

program
  .command('waivers')
  .description('free agents que melhoram o time')
  .option('-w, --week <n>', 'semana', week)
  .option('-n, --notify', 'envia no Telegram')
  .action(async (o) => print(await runWaiversJob(o)));

program
  .command('trades')
  .description('ideias de troca boas para os dois lados')
  .option('-w, --week <n>', 'semana', week)
  .option('-t, --team <name>', 'só com este time (parte do nome)')
  .option('-n, --notify', 'envia no Telegram')
  .action(async (o) => print(await runTradesJob({ ...o, partner: o.team })));

program
  .command('injuries')
  .description('alerta mudanças de status de lesão no seu time')
  .option('-n, --notify', 'envia no Telegram')
  .action(async (o) => print(await runInjuriesJob(o)));

program
  .command('backtest')
  .description('erro das projeções nas semanas passadas vs baseline')
  .option('-w, --weeks <range>', 'semanas (ex.: 2-6)', '2-6')
  .action(async (o) => {
    const league = await loadLeague(requireLeagueId());
    const rows = await runBacktest(league, league.season, parseWeeks(o.weeks));
    console.table(
      rows.map((r) => ({
        posição: r.position,
        n: r.n,
        'MAE modelo': r.modelMae.toFixed(2),
        'MAE baseline': r.baselineMae.toFixed(2),
        viés: r.modelBias.toFixed(2),
      })),
    );
  });

program
  .command('bot')
  .description('daemon: envia o outbox e responde comandos no Telegram')
  .action(() => runBot());

program
  .parseAsync()
  .then(async (cmd) => {
    // O daemon do bot nunca retorna; os demais comandos encerram a conexão
    if (cmd.args[0] !== 'bot') await sql.end();
  })
  .catch(async (err) => {
    log.error(err instanceof Error ? err.message : err);
    await sql.end({ timeout: 1 });
    process.exitCode = 1;
  });
