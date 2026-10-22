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
  if (code === 'ECONNREFUSED' && port !== undefined) {
    msg += ` — nada escutando na porta ${port}; se for o Postgres, rode \`pnpm db:up\``;
  }
  return msg;
}
