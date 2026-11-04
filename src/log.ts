import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import pino, { type DestinationStream, type StreamEntry } from 'pino';
import pretty from 'pino-pretty';
import roll from 'pino-roll';
import { config } from './config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REDACTED = '[REDACTED]';

/** Valores sensíveis do .env que nunca devem chegar a um log, nem dentro de mensagens ou stacks. */
function secretValues(): string[] {
  const values = [config.TELEGRAM_BOT_TOKEN, config.SLEEPER_TOKEN, config.ANTHROPIC_API_KEY];
  try {
    values.push(decodeURIComponent(new URL(config.DATABASE_URL).password));
  } catch {
    // DATABASE_URL já é validada pelo schema; sem senha não há o que mascarar
  }
  // Valores curtos geram falsos positivos e não são segredos reais
  return values.filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

/** Substitui segredos conhecidos em uma linha de log já serializada. */
export function scrubSecrets(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join(REDACTED);
  // Tokens de bot do Telegram em URLs (api.telegram.org/bot<token>/...)
  return out.replace(/\/bot\d+:[\w-]+/g, `/bot${REDACTED}`);
}

function scrubbed(dest: DestinationStream, secrets: readonly string[]): DestinationStream {
  return { write: (line: string) => dest.write(scrubSecrets(line, secrets)) };
}

const textFile = async (dir: string, name: string, keep: number) =>
  pretty({
    colorize: false,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l o',
    ignore: 'hostname',
    sync: true,
    destination: await roll({
      // pino-roll 4 ignora a opção `extension`; a extensão vai no próprio nome
      file: join(dir, name, `${name}.txt`),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      size: '10m',
      mkdir: true,
      sync: true,
      limit: { count: keep, removeOtherLogFiles: true },
    }),
  });

async function streams(): Promise<StreamEntry[]> {
  const secrets = secretValues();
  const stdout: DestinationStream = process.stdout.isTTY ? pretty({ ignore: 'pid,hostname' }) : process.stdout;
  const entries: StreamEntry[] = [{ level: 'trace', stream: scrubbed(stdout, secrets) }];
  // Testes não escrevem em disco
  if (process.env.VITEST || !config.LOG_DIR) return entries;

  const dir = isAbsolute(config.LOG_DIR) ? config.LOG_DIR : resolve(ROOT, config.LOG_DIR);
  try {
    entries.push(
      { level: 'trace', stream: scrubbed(await textFile(dir, 'app', config.LOG_RETENTION_FILES), secrets) },
      { level: 'warn', stream: scrubbed(await textFile(dir, 'errors', config.LOG_ERROR_RETENTION_FILES), secrets) },
    );
  } catch (err) {
    // Sem permissão/espaço em disco: segue só com o stdout em vez de derrubar o processo
    process.stderr.write(`Não foi possível abrir os arquivos de log em ${dir}: ${String(err)}\n`);
  }
  return entries;
}

export const log = pino(
  {
    level: config.LOG_LEVEL,
    base: { pid: process.pid, cmd: process.argv[2] ?? null },
    redact: {
      paths: ['authorization', '*.authorization', 'headers.authorization', '*.headers.authorization', 'token', '*.token', 'apiKey', '*.apiKey'],
      censor: REDACTED,
    },
  },
  pino.multistream(await streams(), { dedupe: false }),
);
