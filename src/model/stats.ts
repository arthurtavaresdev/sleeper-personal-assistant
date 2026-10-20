/** CDF da normal padrão (aproximação de Abramowitz-Stegun 26.2.17, erro < 7.5e-8). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** P(X >= x) para X ~ N(mean, sd). */
export function probAtLeast(x: number, mean: number, sd: number): number {
  if (sd <= 0) return mean >= x ? 1 : 0;
  return 1 - normCdf((x - mean) / sd);
}

/** P(a <= X < b) para X ~ N(mean, sd). */
export function probBetween(a: number, b: number, mean: number, sd: number): number {
  return normCdf((b - mean) / sd) - normCdf((a - mean) / sd);
}

/** Média ponderada entre a observação e um prior: (obs + prior·k) / (n + k). */
export function shrink(weightedSum: number, weightedN: number, prior: number, k: number): number {
  return (weightedSum + prior * k) / (weightedN + k);
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
