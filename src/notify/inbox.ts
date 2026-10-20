import type { InboxVerdict } from '../analysis/inbox.js';
import type { Projection } from '../model/projection.js';
import { escapeHtml as e } from './telegram.js';

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
const LABEL = {
  favorable: '✅ Favorável pelos jogadores modelados',
  negotiate: '🤝 Negociar — ganho ou valor pouco convincente',
  unfavorable: '⛔ Desfavorável pelos jogadores modelados',
  review: '🔎 Revisão manual — avaliação parcial',
};

export function formatInbox(reports: InboxVerdict[], projections: Map<string, Projection>): string {
  const lines = ['📬 <b>Propostas de trade recebidas</b>'];
  if (!reports.length) return lines.concat('', 'Nenhuma proposta recebida aguardando seu aceite.').join('\n');
  const player = (id: string) => {
    const p = projections.get(id);
    return p ? `${e(p.name)} (${e(p.position)})` : `Jogador ${e(id)} (sem projeção)`;
  };
  for (const r of reports) {
    const pick = (p: InboxVerdict['picksGive'][number]) => `Pick ${e(p.season)} · rodada ${p.round} · origem time ${p.roster_id}`;
    const give = [...r.give.map(player), ...r.picksGive.map(pick), ...(r.faabGive ? [`$${r.faabGive} FAAB`] : [])];
    const get = [...r.get.map(player), ...r.picksGet.map(pick), ...(r.faabGet ? [`$${r.faabGet} FAAB`] : [])];
    lines.push('', `<b>Com ${r.partners.map(p => e(p.ownerName)).join(' + ') || 'participante não identificado'}</b>`,
      `📤 Dou: ${give.join(' + ') || '—'}`, `📥 Recebo: ${get.join(' + ') || '—'}`,
      `Lineup: ${signed(r.weekGain)} pts nesta semana · ${signed(r.rosGain)} pts no restante da temporada`,
      `Valor posicional dos jogadores: dou ${r.marketGive.toFixed(1)} · recebo ${r.marketGet.toFixed(1)} (índice heurístico)`);
    for (const p of r.partnerGains) lines.push(`Parceiro ${e(p.name)}: ${signed(p.gain)} pts no restante da temporada`);
    lines.push(`<b>${LABEL[r.verdict]}</b>`);
    for (const reason of r.reasons) lines.push(`• ${e(reason)}`);
    if (r.counter) {
      lines.push('💬 <b>Alternativa para negociar</b>',
        `Dou: ${r.counter.give.map(p => player(p.sleeperId)).join(' + ')}`,
        `Recebo: ${r.counter.get.map(p => player(p.sleeperId)).join(' + ')}`,
        `Ganho ROS: meu time ${signed(r.counter.myGain)} · parceiro ${signed(r.counter.theirGain)} pts`);
    }
    lines.push(`<code>${e(r.transactionId)}</code>`);
  }
  lines.push('', '<i>Análise informativa; nenhuma proposta foi aceita, rejeitada ou enviada.</i>');
  return lines.join('\n');
}
