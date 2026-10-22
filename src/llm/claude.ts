import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';

/** Formatos de imagem aceitos pela API da Anthropic. */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export const ExtractedTrade = z.object({
  sides: z.array(z.object({
    /** Nome do time ou usuário exibido para este lado, se houver. */
    owner: z.string().nullable(),
    players: z.array(z.object({ name: z.string(), position: z.string().nullable(), team: z.string().nullable() })),
    picks: z.array(z.object({ season: z.string().nullable(), round: z.number().int() })),
    faab: z.number().nullable(),
  })),
  /** Avisos sobre a leitura: imagem cortada, texto ilegível, mais de dois times etc. */
  notes: z.string().nullable(),
});
export type ExtractedTrade = z.infer<typeof ExtractedTrade>;

const EXTRACT_PROMPT = `A imagem é um print de uma proposta de troca de fantasy football (NFL) no app Sleeper.
Liste os lados da troca. Em cada lado, coloque os ativos que esse time ENTREGA, não os que recebe.
- owner: nome do time ou usuário mostrado para o lado, ou null se não aparecer.
- players: nome exatamente como aparece (não complete nomes abreviados), posição (QB, RB, WR, TE, K, DEF) e sigla do time da NFL quando visíveis; senão null.
- picks: escolhas de draft com temporada e rodada.
- faab: valor de FAAB entregue, ou null.
Não invente jogadores que não estão legíveis. Use notes para avisar sobre partes cortadas, ilegíveis ou troca com mais de dois times.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) throw new Error('Configure ANTHROPIC_API_KEY no .env para usar o trade calculator por imagem.');
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

export const llmConfigured = () => Boolean(config.ANTHROPIC_API_KEY);

/** Lê os ativos de cada lado da troca. Os IDs são resolvidos depois, contra os rosters da liga. */
export async function extractTradeFromImage(image: Buffer, mediaType: ImageMediaType, caption?: string): Promise<ExtractedTrade> {
  const response = await anthropic().messages.parse({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
        { type: 'text', text: caption ? `${EXTRACT_PROMPT}\n\nLegenda enviada pelo usuário: ${caption}` : EXTRACT_PROMPT },
      ],
    }],
    output_config: { format: zodOutputFormat(ExtractedTrade) },
  });
  if (response.stop_reason === 'refusal') throw new Error('O modelo recusou a leitura da imagem.');
  if (!response.parsed_output) throw new Error('Não foi possível ler a troca na imagem.');
  return response.parsed_output;
}

const COMMENT_PROMPT = `Você comenta trocas de fantasy football para o dono do time, em português do Brasil.
Abaixo está a avaliação calculada pelo modelo próprio do aplicativo (lineup ótimo semana a semana e valor posicional).
Escreva de 2 a 4 frases, em texto puro sem markdown, explicando se a troca faz sentido e por quê.
Use somente os números e fatos fornecidos; não invente projeções, notícias ou lesões.
Preferência posicional do usuário: RB > WR > TE > QB > K > DEF. Não contradiga o veredito do modelo.`;

/** Comentário qualitativo sobre a avaliação já calculada; não altera o veredito. */
export async function tradeCommentary(report: string): Promise<string | null> {
  const response = await anthropic().beta.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: COMMENT_PROMPT,
    messages: [{ role: 'user', content: report }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  return text || null;
}
