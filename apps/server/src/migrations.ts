/**
 * The Server's Postgres schema. Migrations are plain SQL strings applied in
 * order on startup, so upgrading never needs hand-run SQL. SQL lives in
 * TypeScript rather than `.sql` files so it bundles into the single binary
 * without a file loader.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const migrations: Migration[] = [
  {
    id: "0001_server_spine",
    sql: `
      create table users (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        email text not null unique,
        created_at timestamptz not null default now()
      );

      create table tokens (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        token_hash text not null unique,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );

      create table sessions (
        id text primary key,
        user_id uuid not null references users(id) on delete cascade,
        agent text not null,
        agent_version text not null,
        cwd text,
        started_at timestamptz,
        ended_at timestamptz,
        parent_session_id text,
        spawned_by_turn_id text,
        event_seq integer not null default 0,
        created_at timestamptz not null default now()
      );

      create table turns (
        session_id text not null references sessions(id) on delete cascade,
        id text not null,
        turn_seq integer not null,
        parent_turn_id text,
        prompt text,
        response text,
        started_at timestamptz,
        ended_at timestamptz,
        created_at timestamptz not null default now(),
        primary key (session_id, id)
      );

      create index turns_session_seq_idx on turns (session_id, turn_seq);

      create table events (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        event_seq integer not null,
        kind text not null,
        agent text not null,
        agent_version text not null,
        occurred_at timestamptz not null,
        event jsonb not null,
        raw jsonb,
        created_at timestamptz not null default now(),
        unique (session_id, event_seq)
      );

      create index events_session_seq_idx on events (session_id, event_seq);
    `,
  },
  {
    id: "0002_model_requests",
    sql: `
      create table model_requests (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        event_seq integer not null,
        turn_id text not null,
        provider text not null,
        model text not null,
        input_tokens integer,
        output_tokens integer,
        latency_ms integer,
        cost_usd numeric(14, 6),
        occurred_at timestamptz not null,
        created_at timestamptz not null default now()
      );

      create index model_requests_session_turn_idx
        on model_requests (session_id, turn_id);
      create index model_requests_session_seq_idx
        on model_requests (session_id, event_seq);
    `,
  },
  {
    id: "0003_rollups",
    sql: `
      -- A per-User, per-day cache of what the Model requests that day add up to.
      -- Recomputable from model_requests, so it is a cache, not a second source
      -- of truth. spend_usd is null when every Model request that day reported
      -- no Cost, and otherwise the sum of the costs that were reported.
      -- The counts are distinct Sessions, distinct Turns, and Model requests
      -- among the day's Model requests.
      create table user_daily_rollup (
        user_id uuid not null references users(id) on delete cascade,
        day date not null,
        spend_usd numeric(14, 6),
        session_count integer not null default 0,
        turn_count integer not null default 0,
        request_count integer not null default 0,
        top_agent text,
        primary key (user_id, day)
      );

      -- A per-User, per-hour cache, the 24 points of a User's daily sparkline.
      -- hour is the UTC wall clock the Model requests landed in.
      create table user_hourly_rollup (
        user_id uuid not null references users(id) on delete cascade,
        hour timestamp not null,
        spend_usd numeric(14, 6),
        request_count integer not null default 0,
        primary key (user_id, hour)
      );
    `,
  },
];
