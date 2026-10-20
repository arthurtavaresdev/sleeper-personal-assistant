import postgres from 'postgres';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  onnotice: () => {},
  types: { bigint: postgres.BigInt },
  transform: { undefined: null },
});

export type Sql = typeof sql;

/** Converte numeric (string) do driver em number. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Carrega um CSV (stream HTTP) numa tabela de staging com todas as colunas text,
 * recriando a tabela a partir do cabeçalho e usando COPY ... FROM STDIN.
 */
export async function copyCsvToStaging(
  table: string,
  body: ReadableStream<Uint8Array>,
  opts: { nullToken?: string } = {},
): Promise<number> {
  const nodeStream = Readable.fromWeb(body as never);
  const { header, rest } = await splitHeader(nodeStream);
  const cols = parseCsvHeader(header);
  const ident = (c: string) => `"${c.replace(/"/g, '""')}"`;

  await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  await sql.unsafe(`CREATE UNLOGGED TABLE ${table} (${cols.map((c) => `${ident(c)} text`).join(', ')})`);

  const nullOpt = opts.nullToken ? `, NULL '${opts.nullToken}'` : '';
  const writable = await sql.unsafe(`COPY ${table} FROM STDIN WITH (FORMAT csv${nullOpt})`).writable();
  await pipeline(rest, writable);

  const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  return row!.n as number;
}

/** Lê a primeira linha do stream e devolve o restante como novo stream. */
async function splitHeader(stream: Readable): Promise<{ header: string; rest: Readable }> {
  const iterator = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) throw new Error('CSV vazio');
    buf = Buffer.concat([buf, value as Buffer]);
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) {
      const header = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
      const remainder = buf.subarray(nl + 1);
      const rest = Readable.from(
        (async function* () {
          if (remainder.length) yield remainder;
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value as Buffer;
          }
        })(),
      );
      return { header, rest };
    }
  }
}

function parseCsvHeader(line: string): string[] {
  return line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
}

/** Executa fn sob um advisory lock; retorna null se outro processo já o detém. */
export async function withJobLock<T>(job: string, fn: () => Promise<T>): Promise<T | null> {
  const conn = await sql.reserve();
  const key = 'job:' + job;
  try {
    const [lock] = await conn`SELECT pg_try_advisory_lock(hashtext(${key})) AS ok`;
    if (!lock!.ok) return null;
    const [run] = await sql`INSERT INTO app.job_runs (job) VALUES (${job}) RETURNING id`;
    try {
      const result = await fn();
      await sql`UPDATE app.job_runs SET finished_at = now(), ok = true WHERE id = ${run!.id}`;
      return result;
    } catch (err) {
      await sql`UPDATE app.job_runs SET finished_at = now(), ok = false, error = ${String(err)} WHERE id = ${run!.id}`;
      throw err;
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${key}))`;
    }
  } finally {
    conn.release();
  }
}

/** true se a fonte foi buscada há menos de ttlHours. */
export async function isFresh(source: string, ttlHours: number): Promise<boolean> {
  const [row] = await sql`
    SELECT fetched_at > now() - make_interval(hours => ${ttlHours}) AS fresh
    FROM raw.source_fetches WHERE source = ${source}`;
  return Boolean(row?.fresh);
}

export async function markFetched(source: string, rowCount: number): Promise<void> {
  await sql`
    INSERT INTO raw.source_fetches (source, fetched_at, row_count) VALUES (${source}, now(), ${rowCount})
    ON CONFLICT (source) DO UPDATE SET fetched_at = now(), row_count = excluded.row_count`;
}
