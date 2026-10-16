import type { Pool, PoolClient } from "pg";
import type { ModelRequestEvent, NormalEvent } from "@slopwatch/events";
import type { User } from "./db";

/** One User's row in the leaderboard. */
export interface LeaderboardRow {
  user: User;
  /** What the User's Model requests cost on the day, or null when unknown. */
  spendUsd: number | null;
  sessionCount: number;
  turnCount: number;
  requestCount: number;
  /** The coding agent that produced most of the User's Model requests. */
  topAgent: string | null;
  /** This 7 days' spend over the previous 7 days, as a signed fraction. */
  delta7d: number | null;
  /** 24 hourly spend points of the day, midnight UTC first. */
  hourlySpend: (number | null)[];
}

/** Org-level spend for one coding agent on the day. */
export interface AgentSpend {
  agent: string;
  spendUsd: number | null;
  requestCount: number;
}

/**
 * Rebuild the rollup buckets a batch of Model requests landed in, straight from
 * `model_requests`. Recomputing the whole bucket rather than incrementing keeps
 * the rollups provably consistent with the Model requests that produced them,
 * and makes a replay idempotent. Runs inside the ingestion transaction, so a
 * rolled-back batch leaves no rollup behind.
 *
 * Every figure in a bucket is counted from `model_requests`, so the tables are
 * derivable from them alone: a Session or Turn that produced no Model request
 * is not a rollup row.
 */
export async function recomputeRollups(
  client: PoolClient,
  userId: string,
  appliedEvents: NormalEvent[],
): Promise<void> {
  const days = new Set<string>();
  const hours = new Set<string>();
  // `occurredAt` is validated at ingestion, so it always parses.
  const requests = appliedEvents.filter(
    (event): event is ModelRequestEvent => event.kind === "model.request",
  );
  for (const request of requests) {
    const at = new Date(request.occurredAt);
    days.add(utcDay(at));
    hours.add(utcHour(at));
  }

  for (const day of days) await recomputeDay(client, userId, day);
  for (const hour of hours) await recomputeHour(client, userId, hour);
}

/** The UTC wall-clock date of an instant, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The UTC wall-clock hour an instant falls in, as a tz-free timestamp. */
function utcHour(at: Date): string {
  return `${at.toISOString().slice(0, 13)}:00:00`;
}

async function recomputeDay(
  client: PoolClient,
  userId: string,
  day: string,
): Promise<void> {
  await client.query(
    `insert into user_daily_rollup
       (user_id, day, spend_usd, session_count, turn_count, request_count, top_agent)
     select s.user_id, $2::date,
       sum(m.cost_usd),
       count(distinct m.session_id),
       count(distinct m.turn_id),
       count(*),
       mode() within group (order by s.agent)
     from model_requests m
     join sessions s on s.id = m.session_id
     where s.user_id = $1
       and (m.occurred_at at time zone 'UTC')::date = $2::date
     group by s.user_id
     on conflict (user_id, day) do update set
       spend_usd = excluded.spend_usd,
       session_count = excluded.session_count,
       turn_count = excluded.turn_count,
       request_count = excluded.request_count,
       top_agent = excluded.top_agent`,
    [userId, day],
  );
}

async function recomputeHour(
  client: PoolClient,
  userId: string,
  hour: string,
): Promise<void> {
  await client.query(
    `insert into user_hourly_rollup (user_id, hour, spend_usd, request_count)
     select s.user_id,
       date_trunc('hour', m.occurred_at at time zone 'UTC'),
       sum(m.cost_usd),
       count(*)
     from model_requests m
     join sessions s on s.id = m.session_id
     where s.user_id = $1
       and date_trunc('hour', m.occurred_at at time zone 'UTC') = $2::timestamp
     group by s.user_id, date_trunc('hour', m.occurred_at at time zone 'UTC')
     on conflict (user_id, hour) do update set
       spend_usd = excluded.spend_usd,
       request_count = excluded.request_count`,
    [userId, hour],
  );
}

/**
 * The leaderboard for one day: every User with a rollup for that day, ranked by
 * that day's spend descending, each carrying its counts, top coding agent, a
 * 24-point hourly spend sparkline, and the 7-day delta.
 */
export async function leaderboard(
  pool: Pool,
  day: string,
): Promise<LeaderboardRow[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    email: string;
    spend_usd: string | null;
    session_count: number;
    turn_count: number;
    request_count: number;
    top_agent: string | null;
  }>(
    `select u.id, u.name, u.email, d.spend_usd,
            d.session_count, d.turn_count, d.request_count, d.top_agent
     from user_daily_rollup d
     join users u on u.id = d.user_id
     where d.day = $1::date
     order by d.spend_usd desc nulls last, u.name asc`,
    [day],
  );

  if (rows.length === 0) return [];

  const userIds = rows.map((row) => row.id);
  const [hourly, deltas] = await Promise.all([
    hourlySpendByUser(pool, userIds, day),
    delta7dByUser(pool, userIds, day),
  ]);

  return rows.map((row) => ({
    user: { id: row.id, name: row.name, email: row.email },
    spendUsd: toSpend(row.spend_usd),
    sessionCount: row.session_count,
    turnCount: row.turn_count,
    requestCount: row.request_count,
    topAgent: row.top_agent,
    delta7d: deltas.get(row.id) ?? null,
    hourlySpend: hourly.get(row.id) ?? emptyHourly(),
  }));
}

/** 24 hourly spend points of `day`, midnight UTC first, keyed by User. */
async function hourlySpendByUser(
  pool: Pool,
  userIds: string[],
  day: string,
): Promise<Map<string, (number | null)[]>> {
  const { rows } = await pool.query<{
    user_id: string;
    hour: number;
    spend_usd: string | null;
  }>(
    `select user_id, extract(hour from hour)::int as hour, spend_usd
     from user_hourly_rollup
     where user_id = any($1::uuid[])
       and hour >= $2::timestamp
       and hour < $2::timestamp + interval '1 day'`,
    [userIds, day],
  );

  const byUser = new Map<string, (number | null)[]>();
  for (const row of rows) {
    const points = byUser.get(row.user_id) ?? emptyHourly();
    points[row.hour] = toSpend(row.spend_usd);
    byUser.set(row.user_id, points);
  }
  return byUser;
}

/** This week's spend over the previous week's, keyed by User; null if unknown. */
async function delta7dByUser(
  pool: Pool,
  userIds: string[],
  day: string,
): Promise<Map<string, number | null>> {
  const { rows } = await pool.query<{
    user_id: string;
    this_week: string | null;
    prev_week: string | null;
  }>(
    `select user_id,
       sum(spend_usd) filter (where day > $2::date - 7) as this_week,
       sum(spend_usd) filter (
         where day <= $2::date - 7 and day > $2::date - 14
       ) as prev_week
     from user_daily_rollup
     where user_id = any($1::uuid[])
       and day > $2::date - 14
       and day <= $2::date
     group by user_id`,
    [userIds, day],
  );

  const byUser = new Map<string, number | null>();
  for (const row of rows) {
    byUser.set(row.user_id, delta(row.prev_week, row.this_week));
  }
  return byUser;
}

/** A signed fraction of change from `prev` to `this`, or null when unknowable. */
function delta(prev: string | null, current: string | null): number | null {
  if (prev === null || current === null) return null;
  const previous = Number(prev);
  if (previous <= 0) return null;
  return (Number(current) - previous) / previous;
}

function emptyHourly(): (number | null)[] {
  return Array.from({ length: 24 }, () => 0);
}

/** Org-level spend per coding agent for one day. */
export async function spendByAgent(
  pool: Pool,
  day: string,
): Promise<AgentSpend[]> {
  const { rows } = await pool.query<{
    agent: string;
    spend_usd: string | null;
    request_count: string;
  }>(
    `select s.agent, sum(m.cost_usd) as spend_usd, count(*) as request_count
     from model_requests m
     join sessions s on s.id = m.session_id
     where (m.occurred_at at time zone 'UTC')::date = $1::date
     group by s.agent
     order by spend_usd desc nulls last, s.agent asc`,
    [day],
  );
  return rows.map((row) => ({
    agent: row.agent,
    spendUsd: toSpend(row.spend_usd),
    requestCount: Number(row.request_count),
  }));
}

/** Parse a Postgres `numeric` spend, which the driver returns as a string. */
function toSpend(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcToday(): string {
  return utcDay(new Date());
}
