type CodedError = Error & { code?: string; address?: string; port?: number };

/**
 * Mensagem legível para o terminal e o journal. AggregateError (ex.: ECONNREFUSED
 * do driver do Postgres ao tentar IPv6 e IPv4) chega com `message` vazia.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as CodedError;
  const inner = err instanceof AggregateError ? (err.errors as CodedError[]) : [];
  const first = inner[0];
  const code = e.code ?? first?.code;
  const port = e.port ?? first?.port;
  let msg = e.message || inner.map((i) => i.message).filter(Boolean).join('; ') || code || e.name;
  if (msg === 'fetch failed') msg += networkCode(err);
  if (code === 'ECONNREFUSED' && port !== undefined) {
    msg += ` — nada escutando na porta ${port}; se for o Postgres, rode \`pnpm db:up\``;
  }
  return msg;
}

/** Código da causa de uma falha de rede do fetch (undici): ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT… */
export function networkCode(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return ' (timeout)';
  const cause = (err as { cause?: { code?: unknown; errors?: { code?: unknown }[] } })?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : '';
}

/** Falha de rede do fetch (DNS, conexão, reset, timeout) — transitória, vale repetir. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError');
}

/**
 * Embrulha uma falha de rede com o recurso que estava sendo buscado e a causa,
 * em vez do genérico "fetch failed". A causa original segue em `cause` para o log.
 */
export function networkFailure(label: string, err: unknown, attempts?: number): Error {
  const tries = attempts && attempts > 1 ? ` após ${attempts} tentativas` : '';
  return new Error(`${label}: falha de rede${networkCode(err)}${tries}`, { cause: err });
}
