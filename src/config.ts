import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SLEEPER_USERNAME: z.string().optional().default(''),
  LEAGUE_ID: z.string().optional().default(''),
  /** Token da sessão web do Sleeper (opcional): só para ler as SUAS propostas de waiver pendentes. */
  SLEEPER_TOKEN: z.string().optional().default(''),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  TZ: z.string().default('America/Sao_Paulo'),
  LOG_LEVEL: z.string().default('info'),
});

export const config = schema.parse(process.env);

export function requireLeagueId(): string {
  if (!config.LEAGUE_ID) throw new Error('LEAGUE_ID não configurado. Rode `pnpm cli setup` primeiro.');
  return config.LEAGUE_ID;
}
