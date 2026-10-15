import type { NormalEvent, SessionStartedEvent } from "@slopwatch/events";
import { Pool, type PoolClient } from "pg";
import { hashToken, mintToken } from "./auth";
import { migrations } from "./migrations";

/** A person with an identity in one Slopwatch organization. */
export interface User {
  id: string;
  name: string;
  email: string;
}

/** One Session as listed in the dashboard and the sessions API. */
export interface SessionSummary {
  id: string;
  agent: string;
  agentVersion: string;
  cwd: string | null;
  user: User;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId: string | null;
  turnCount: number;
  /** How much the Session cost, or null when no Model request reported one. */
  costUsd: number | null;
}

/** One Model request inside a Turn: one call the agent made to a provider. */
export interface ModelRequest {
  id: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

/** One Turn inside a Session. */
export interface Turn {
  id: string;
  parentTurnId: string | null;
  prompt: string | null;
  response: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** How much the Turn cost, or null when no Model request reported one. */
  costUsd: number | null;
  modelRequests: ModelRequest[];
}

/** A Session with its Turns and the child Sessions it spawned. */
export interface SessionDetail extends SessionSummary {
  spawnedByTurnId: string | null;
  turns: Turn[];
  /** Sessions spawned as Subagents by a Turn in this Session. */
  childSessions: SessionSummary[];
}

/** An Event as stored, carrying the per-Session sequence it was assigned. */
export interface StoredEvent {
  seq: number;
  event: NormalEvent;
}

/** Thrown when a batch names a Session that belongs to another User. */
export class SessionOwnershipError extends Error {
  override readonly name = "SessionOwnershipError";

  constructor(readonly sessionId: string) {
    super(`session ${sessionId} belongs to another User`);
  }
}

const MIGRATION_LOCK_KEY = 0x5107_7a7c;

/**
 * Open the connection pool. An idle client that fails (Postgres restarted,
 * network blip) emits `error`, and an unhandled `error` event kills the
 * process; this listener turns that into a loud log while the pool replaces the
 * client.
 */
export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (error) => {
    console.error("[server] idle Postgres client error", error);
  });
  return pool;
}

/**
 * Apply every pending migration in order, tracked in `schema_migrations`. A
 * Postgres advisory lock serialises concurrent replicas booting at once.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )`,
    );
    const { rows } = await client.query<{ id: string }>(
      "select id from schema_migrations",
    );
    const applied = new Set(rows.map((row) => row.id));

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [
          migration.id,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}

/** Create a User. A duplicate email surfaces as a Postgres unique violation. */
export async function createUser(
  pool: Pool,
  name: string,
  email: string,
): Promise<User> {
  const { rows } = await pool.query<User>(
    "insert into users (name, email) values ($1, $2) returning id, name, email",
    [name, email],
  );
  return rows[0];
}

/** Mint a long-lived bearer token for a User and store only its hash. */
export async function issueToken(pool: Pool, userId: string): Promise<string> {
  const token = mintToken();
  await pool.query("insert into tokens (user_id, token_hash) values ($1, $2)", [
    userId,
    hashToken(token),
  ]);
  return token;
}

/** Resolve the User a bearer token belongs to, or null when it is not valid. */
export async function findUserByToken(
  pool: Pool,
  token: string,
): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `select u.id, u.name, u.email
     from tokens t
     join users u on u.id = t.user_id
     where t.token_hash = $1 and t.revoked_at is null`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/**
 * Persist a batch of Events for the acting User. Every Event is attributed to
 * that User, never to anything the payload claims. Replays are idempotent: an
 * Event whose id is already stored is skipped. Returns how many were newly
 * persisted.
 */
export async function storeBatch(
  pool: Pool,
  userId: string,
  events: NormalEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accepted = await storeBatchInTransaction(client, userId, events);
    await client.query("commit");
    return accepted;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function storeBatchInTransaction(
  client: PoolClient,
  userId: string,
  events: NormalEvent[],
): Promise<number> {
  const sessionIds = [...new Set(events.map((event) => event.sessionId))];
  for (const sessionId of sessionIds) {
    await ensureSession(client, userId, sessionId, events);
  }

  // Lock each Session row so its `event_seq` stays gap-free under concurrent
  // ingestion, then assign sequences in the order the Events were sent.
  const nextSeq = new Map<string, number>();
  for (const sessionId of sessionIds) {
    const { rows } = await client.query<{ event_seq: number }>(
      "select event_seq from sessions where id = $1 for update",
      [sessionId],
    );
    // `ensureSession` just inserted or found the row, so it is always present.
    nextSeq.set(sessionId, rows[0].event_seq);
  }

  let accepted = 0;
  for (const event of events) {
    const seq = (nextSeq.get(event.sessionId) ?? 0) + 1;
    const inserted = await client.query(
      `insert into events
         (id, session_id, event_seq, kind, agent, agent_version, occurred_at, event, raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing
       returning event_seq`,
      [
        event.id,
        event.sessionId,
        seq,
        event.kind,
        event.agent,
        event.agentVersion,
        event.occurredAt,
        JSON.stringify(event),
        JSON.stringify(event.raw ?? null),
      ],
    );
    if (inserted.rowCount !== 1) continue;

    nextSeq.set(event.sessionId, seq);
    accepted += 1;
    await applyEvent(client, event, seq);
  }

  for (const [sessionId, seq] of nextSeq) {
    await client.query("update sessions set event_seq = $2 where id = $1", [
      sessionId,
      seq,
    ]);
  }

  return accepted;
}

async function ensureSession(
  client: PoolClient,
  userId: string,
  sessionId: string,
  events: NormalEvent[],
): Promise<void> {
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
  const first = sessionEvents[0];
  const started = sessionEvents.find(
    (event): event is SessionStartedEvent => event.kind === "session.started",
  );

  // `where sessions.user_id = excluded.user_id` makes a Session id owned by
  // another User refuse to update, returning no row: the fingerprint of a
  // cross-User claim.
  const { rowCount } = await client.query(
    `insert into sessions
       (id, user_id, agent, agent_version, cwd, started_at, parent_session_id, spawned_by_turn_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       agent = excluded.agent,
       agent_version = excluded.agent_version,
       cwd = coalesce(sessions.cwd, excluded.cwd),
       started_at = coalesce(sessions.started_at, excluded.started_at),
       parent_session_id = coalesce(sessions.parent_session_id, excluded.parent_session_id),
       spawned_by_turn_id = coalesce(sessions.spawned_by_turn_id, excluded.spawned_by_turn_id)
     where sessions.user_id = excluded.user_id
     returning id`,
    [
      sessionId,
      userId,
      first.agent,
      first.agentVersion,
      started?.cwd ?? null,
      started?.occurredAt ?? null,
      started?.parentSessionId ?? null,
      started?.spawnedByTurnId ?? null,
    ],
  );
  if (rowCount === 0) throw new SessionOwnershipError(sessionId);
}

async function applyEvent(
  client: PoolClient,
  event: NormalEvent,
  seq: number,
): Promise<void> {
  switch (event.kind) {
    case "turn.started":
      await client.query(
        `insert into turns (session_id, id, turn_seq, parent_turn_id, prompt, started_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (session_id, id) do update set
           turn_seq = least(turns.turn_seq, excluded.turn_seq),
           prompt = coalesce(excluded.prompt, turns.prompt),
           parent_turn_id = coalesce(excluded.parent_turn_id, turns.parent_turn_id),
           started_at = coalesce(turns.started_at, excluded.started_at)`,
        [
          event.sessionId,
          event.turnId,
          seq,
          event.parentTurnId ?? null,
          event.prompt,
          event.occurredAt,
        ],
      );
      return;
    case "turn.ended":
      await client.query(
        `insert into turns (session_id, id, turn_seq, response, ended_at)
         values ($1, $2, $3, $4, $5)
         on conflict (session_id, id) do update set
           turn_seq = least(turns.turn_seq, excluded.turn_seq),
           response = coalesce(excluded.response, turns.response),
           ended_at = coalesce(excluded.ended_at, turns.ended_at)`,
        [event.sessionId, event.turnId, seq, event.response, event.occurredAt],
      );
      return;
    case "model.request":
      await client.query(
        `insert into model_requests
           (id, session_id, event_seq, turn_id, provider, model,
            input_tokens, output_tokens, latency_ms, cost_usd, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (id) do nothing`,
        [
          event.id,
          event.sessionId,
          seq,
          event.turnId,
          event.provider,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.latencyMs ?? null,
          event.costUsd ?? null,
          event.occurredAt,
        ],
      );
      return;
    case "session.ended":
      await client.query(
        "update sessions set ended_at = coalesce(ended_at, $2) where id = $1",
        [event.sessionId, event.occurredAt],
      );
      return;
    default:
      return;
  }
}

/** The Session columns and joins both Session readers project. */
const SESSION_COLUMNS = `s.id, s.agent, s.agent_version, s.cwd,
  u.id as user_id, u.name as user_name, u.email as user_email,
  s.started_at, s.ended_at, s.parent_session_id, s.spawned_by_turn_id`;
const SESSION_FROM = `from sessions s join users u on u.id = s.user_id`;
/** A Session's Turn count and cost, summed from its own Model requests only. */
const SESSION_AGGREGATES = `(select count(*) from turns t where t.session_id = s.id) as turn_count,
  (select sum(m.cost_usd) from model_requests m where m.session_id = s.id) as cost_usd`;

interface SessionRow {
  id: string;
  agent: string;
  agent_version: string;
  cwd: string | null;
  user_id: string;
  user_name: string;
  user_email: string;
  started_at: Date | null;
  ended_at: Date | null;
  parent_session_id: string | null;
  spawned_by_turn_id: string | null;
}

interface SessionSummaryRow extends SessionRow {
  turn_count: string;
  cost_usd: string | null;
}

/** The fields a Session shares between the list and detail views. */
function toSessionFields(
  row: SessionRow,
): Omit<SessionSummary, "turnCount" | "costUsd"> {
  return {
    id: row.id,
    agent: row.agent,
    agentVersion: row.agent_version,
    cwd: row.cwd,
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    parentSessionId: row.parent_session_id,
  };
}

function toSessionSummary(row: SessionSummaryRow): SessionSummary {
  return {
    ...toSessionFields(row),
    turnCount: Number(row.turn_count),
    costUsd: toCost(row.cost_usd),
  };
}

/** List every Session, newest first, with its Turn count and cost. */
export async function listSessions(pool: Pool): Promise<SessionSummary[]> {
  const { rows } = await pool.query<SessionSummaryRow>(
    `select ${SESSION_COLUMNS}, ${SESSION_AGGREGATES}
     ${SESSION_FROM}
     order by s.started_at desc nulls last, s.created_at desc`,
  );

  return rows.map(toSessionSummary);
}

/** Sessions spawned as Subagents by a Turn in `parentSessionId`. */
async function listChildSessions(
  pool: Pool,
  parentSessionId: string,
): Promise<SessionSummary[]> {
  const { rows } = await pool.query<SessionSummaryRow>(
    `select ${SESSION_COLUMNS}, ${SESSION_AGGREGATES}
     ${SESSION_FROM}
     where s.parent_session_id = $1
     order by s.started_at asc nulls last, s.created_at asc`,
    [parentSessionId],
  );

  return rows.map(toSessionSummary);
}

/** Read one Session with its Turns and child Sessions, or null when absent. */
export async function getSession(
  pool: Pool,
  sessionId: string,
): Promise<SessionDetail | null> {
  const { rows } = await pool.query<SessionRow>(
    `select ${SESSION_COLUMNS}
     ${SESSION_FROM}
     where s.id = $1`,
    [sessionId],
  );
  const session = rows[0];
  if (!session) return null;

  const turnRows = await pool.query<{
    id: string;
    parent_turn_id: string | null;
    prompt: string | null;
    response: string | null;
    started_at: Date | null;
    ended_at: Date | null;
  }>(
    `select id, parent_turn_id, prompt, response, started_at, ended_at
     from turns
     where session_id = $1
     order by turn_seq asc, id asc`,
    [sessionId],
  );

  const requestRows = await pool.query<{
    id: string;
    turn_id: string;
    provider: string;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    cost_usd: string | null;
  }>(
    `select id, turn_id, provider, model,
            input_tokens, output_tokens, latency_ms, cost_usd
     from model_requests
     where session_id = $1
     order by event_seq asc`,
    [sessionId],
  );
  const requestsByTurn = new Map<string, ModelRequest[]>();
  for (const row of requestRows.rows) {
    const requests = requestsByTurn.get(row.turn_id) ?? [];
    requests.push({
      id: row.id,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      costUsd: toCost(row.cost_usd),
    });
    requestsByTurn.set(row.turn_id, requests);
  }

  // Sum in Postgres, where `numeric` is exact, rather than in floating point.
  const turnCostRows = await pool.query<{
    turn_id: string;
    cost_usd: string | null;
  }>(
    `select turn_id, sum(cost_usd) as cost_usd
     from model_requests
     where session_id = $1
     group by turn_id`,
    [sessionId],
  );
  const turnCost = new Map(
    turnCostRows.rows.map((row) => [row.turn_id, row.cost_usd]),
  );

  const turns = turnRows.rows.map((row) => {
    const modelRequests = requestsByTurn.get(row.id) ?? [];
    return {
      id: row.id,
      parentTurnId: row.parent_turn_id,
      prompt: row.prompt,
      response: row.response,
      startedAt: toIso(row.started_at),
      endedAt: toIso(row.ended_at),
      costUsd: toCost(turnCost.get(row.id) ?? null),
      modelRequests,
    };
  });

  const sessionCostRows = await pool.query<{ cost_usd: string | null }>(
    "select sum(cost_usd) as cost_usd from model_requests where session_id = $1",
    [sessionId],
  );
  const costUsd = toCost(sessionCostRows.rows[0].cost_usd);

  return {
    ...toSessionFields(session),
    spawnedByTurnId: session.spawned_by_turn_id,
    turnCount: turns.length,
    costUsd,
    turns,
    childSessions: await listChildSessions(pool, sessionId),
  };
}

/**
 * Read a Session's Events with a sequence greater than `sinceSeq`, in order.
 * This is the incremental-poll contract live-spectate rests on.
 */
export async function listEventsSince(
  pool: Pool,
  sessionId: string,
  sinceSeq: number,
): Promise<StoredEvent[]> {
  const { rows } = await pool.query<{
    event_seq: number;
    event: NormalEvent;
  }>(
    `select event_seq, event
     from events
     where session_id = $1 and event_seq > $2
     order by event_seq asc`,
    [sessionId, sinceSeq],
  );
  return rows.map((row) => ({ seq: row.event_seq, event: row.event }));
}

/** Whether a Session exists, without loading it. */
export async function sessionExists(
  pool: Pool,
  sessionId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "select 1 from sessions where id = $1",
    [sessionId],
  );
  return (rowCount ?? 0) > 0;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Parse a Postgres `numeric` cost, which the driver returns as a string. */
function toCost(value: string | null): number | null {
  return value === null ? null : Number(value);
}
