import type { LineupReport } from '../analysis/lineup.js';
import type { TradeIdea } from '../analysis/trades.js';
import type { WaiverMove } from '../analysis/waivers.js';
import type { Projection } from '../model/projection.js';
import { escapeHtml as e } from './telegram.js';

const f1 = (x: number) => x.toFixed(1);
const signed = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);

const SLOT_LABEL: Record<string, string> = { FLEX: 'FLEX', SUPER_FLEX: 'SFLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T' };

function who(p: Projection): string {
  const opp = p.opponent ? `vs ${p.opponent}` : 'BYE';
  const inj = p.injuryStatus ? ` ⚠️${e(p.injuryStatus)}` : '';
  return `<b>${e(p.name)}</b> (${p.position}, ${p.team || 'FA'} ${opp})${inj}`;
}

export function formatLineup(r: LineupReport, proj: Map<string, Projection>, leagueName: string): string {
  const lines: string[] = [`🏈 <b>Lineup — semana ${r.week}</b> · ${e(leagueName)}`];
  const gain = r.optimal.total - r.currentTotal;

  if (r.changes.length === 0) {
    lines.push('', '✅ Seu lineup atual já é o ótimo.');
  } else {
    lines.push('', `🔁 <b>Mudanças sugeridas</b> (${signed(gain)} pts):`);
    for (const c of r.changes) {
      const out = c.out ? ` no lugar de ${e(c.out.name)} (${f1(c.out.mean)})` : '';
      lines.push(`• ${SLOT_LABEL[c.slot] ?? c.slot}: ${who(c.in)} ${f1(c.in.mean)}${out}`);
    }
  }

  lines.push('', `📋 <b>Lineup ótimo</b> — ${f1(r.optimal.total)} pts projetados`);
  for (const s of r.optimal.slots) {
    const label = (SLOT_LABEL[s.slot] ?? s.slot).padEnd(5);
    if (!s.id) {
      lines.push(`<code>${label}</code> — vazio —`);
      continue;
    }
    const p = proj.get(s.id)!;
    const lock = r.locked.has(s.id) ? ' 🔒' : '';
    lines.push(`<code>${label}</code> ${e(p.name)} ${f1(p.mean)} <i>(${f1(p.p20)}–${f1(p.p80)})</i>${lock}`);
  }

  if (r.alerts.length) {
    lines.push('', '⚠️ <b>Atenção</b>');
    for (const p of r.alerts) lines.push(`• ${who(p)}${p.opponent === null ? ' — sem jogo' : ''}`);
  }
  if (r.closeCalls.length) {
    lines.push('', '🤏 <b>Decisões apertadas</b> (piso–teto)');
    for (const { starter: a, alt: b } of r.closeCalls) {
      lines.push(`• ${e(a.name)} ${f1(a.mean)} (${f1(a.p20)}–${f1(a.p80)}) vs ${e(b.name)} ${f1(b.mean)} (${f1(b.p20)}–${f1(b.p80)})`);
    }
  }
  return lines.join('\n');
}

export function formatWaivers(moves: WaiverMove[], week: number, faab: boolean): string {
  const lines = [`🧲 <b>Waivers — semana ${week}</b>`];
  if (moves.length === 0) return [...lines, '', 'Nenhum free agent melhora seu time de forma relevante.'].join('\n');
  moves.forEach((m, i) => {
    const drop = m.drop ? `\n   ↳ largar ${e(m.drop.name)} (${m.drop.position})` : '\n   ↳ vaga livre, sem largar ninguém';
    const bid = faab && m.faabBid !== null ? ` · 💰 lance sugerido: <b>$${m.faabBid}</b>` : '';
    const hot = m.trendingAdds > 0 ? ` · 🔥 ${m.trendingAdds.toLocaleString('pt-BR')} adds/48h` : '';
    lines.push('', `${i + 1}. ${who(m.add)}${drop}\n   ${signed(m.rosGain)} pts no resto da temporada · ${signed(m.weekGain)} nesta semana${bid}${hot}`);
  });
  return lines.join('\n');
}

export function formatTrades(ideas: TradeIdea[], week: number): string {
  const lines = [`🤝 <b>Ideias de troca — semana ${week}</b>`];
  if (ideas.length === 0) return [...lines, '', 'Nenhuma troca vantajosa para os dois lados encontrada.'].join('\n');
  const names = (ps: Projection[]) => ps.map((p) => `${e(p.name)} (${p.position})`).join(' + ');
  ideas.forEach((t, i) => {
    lines.push(
      '',
      `${i + 1}. Com <b>${e(t.partner.ownerName)}</b>`,
      `   📤 Dou: ${names(t.give)}`,
      `   📥 Recebo: ${names(t.get)}`,
      `   Meu time: ${signed(t.myGain)} pts · Parceiro: ${signed(t.theirGain)} pts (resto da temporada)`,
    );
  });
  lines.push('', '<i>Ganhos medidos no lineup ótimo de cada time, semana a semana.</i>');
  return lines.join('\n');
}

export function formatInjuryAlert(changes: { p: Projection; from: string | null }[], week: number): string {
  const lines = [`🚑 <b>Alerta de lesão — semana ${week}</b>`];
  for (const { p, from } of changes) {
    lines.push(`• ${e(p.name)} (${p.position}, ${p.team}): ${e(from ?? 'Saudável')} → <b>${e(p.injuryStatus ?? 'Saudável')}</b>`);
  }
  lines.push('', 'Rode /lineup para ver o lineup ajustado.');
  return lines.join('\n');
}
