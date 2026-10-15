import { Client } from "pg";

/** Where to reach the Postgres the proof runs against. */
export interface PostgresTarget {
  connectionString: string;
  /** Give up on the handshake after this long. Defaults to 5s. */
  connectionTimeoutMillis?: number;
}

/** What a successful round-trip proves. */
export interface PostgresProbe {
  /** The result of `select 1 + 1`, i.e. a real query, not just a connect. */
  sum: number;
  /** Server banner, e.g. `PostgreSQL 17.11`. */
  serverVersion: string;
}

/**
 * A failure to use the connection, carrying Postgres's own error `code` so the
 * caller can tell "server is down" from "wrong password" without parsing
 * strings.
 */
export class PostgresConnectionError extends Error {
  override readonly name = "PostgresConnectionError";
  readonly code: string | undefined;

  constructor(cause: NodeJS.ErrnoException) {
    super(`cannot reach Postgres: ${cause.message}`, { cause });
    this.code = cause.code;
  }
}

/**
 * Connect, run a query, and disconnect. Proves the `pg` client works end to end
 * on Bun. Any failure during connect is rethrown as {@link PostgresConnectionError}
 * so callers never see a raw driver error.
 */
export async function probePostgres(
  target: PostgresTarget,
): Promise<PostgresProbe> {
  const client = new Client({
    connectionString: target.connectionString,
    connectionTimeoutMillis: target.connectionTimeoutMillis ?? 5_000,
  });

  try {
    await client.connect();
  } catch (thrown) {
    throw new PostgresConnectionError(thrown as NodeJS.ErrnoException);
  }

  try {
    const { rows } = await client.query<{
      sum: number;
      server_version: string;
    }>("select 1 + 1 as sum, version() as server_version");
    return {
      sum: rows[0].sum,
      serverVersion: serverBanner(rows[0].server_version),
    };
  } finally {
    // `end()` is safe to await even after a mid-query failure; swallowing its
    // error would hide a genuine socket problem, so let it propagate.
    await client.end();
  }
}

/** `"PostgreSQL 17.11 on x86_64-…"` → `"PostgreSQL 17.11"`. */
function serverBanner(version: string): string {
  return version.split(" ").slice(0, 2).join(" ");
}
