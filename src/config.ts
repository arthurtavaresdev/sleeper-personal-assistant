import 'dotenv/config';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { z } from 'zod';

// Happy eyeballs do Node espera só 250 ms por endereço. Em redes sem rota IPv6, uma
// conexão IPv4 um pouco mais lenta (~350 ms ao api.telegram.org) era abandonada e o
// fetch falhava com AggregateError [ETIMEDOUT]. Vale para todos os fetch do processo.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SLEEPER_USERNAME: z.string().optional().default(''),
  LEAGUE_ID: z.string().optional().default(''),
  LEAGUE_IDS: z.string().default(''),
  /** Token da sessão web do Sleeper (opcional): só para ler as SUAS propostas de waiver pendentes. */
  SLEEPER_TOKEN: z.string().optional().default(''),
  /** Chave da API da Anthropic (opcional): habilita o trade calculator por imagem. */
  ANTHROPIC_API_KEY: z.string().trim().optional().default(''),
  ANTHROPIC_MODEL: z.string().trim().default('claude-opus-5-5'),
  TELEGRAM_BOT_TOKEN: z.string().trim().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().trim().optional().default(''),
  TZ: z.string().default('America/Sao_Paulo'),
  LOG_LEVEL: z.string().default('info'),
  /** Diretório dos logs em texto (relativo à raiz do projeto). Vazio desativa os arquivos. */
  LOG_DIR: z.string().trim().default('logs'),
  /** Arquivos rotacionados mantidos (diários ou a cada 10 MB). */
  LOG_RETENTION_FILES: z.coerce.number().int().positive().default(14),
  LOG_ERROR_RETENTION_FILES: z.coerce.number().int().positive().default(90),
});

export const config = schema.parse(process.env);

export function requireLeagueId(): string {
  if (!config.LEAGUE_ID) throw new Error('LEAGUE_ID não configurado. Rode `pnpm cli setup` primeiro.');
  return config.LEAGUE_ID;
}
