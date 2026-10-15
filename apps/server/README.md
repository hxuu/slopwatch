# `@slopwatch/server`

The single self-hosted process that receives Events from Listeners, stores them
in Postgres, and serves the dashboard. This is the v1 "spine": the thinnest
complete path through every Server layer, which later tickets thicken.

## Run it

```sh
bun run pg:up                                   # postgres 17 on 127.0.0.1:55433
DATABASE_URL=postgres://slopwatch:slopwatch@127.0.0.1:55433/slopwatch \
SLOPWATCH_ADMIN_TOKEN=$(openssl rand -hex 16) \
  bun run dev
```

| Variable                | Required | Meaning                                              |
| ----------------------- | -------- | ---------------------------------------------------- |
| `DATABASE_URL`          | yes      | Postgres the Server migrates and reads/writes.       |
| `SLOPWATCH_ADMIN_TOKEN` | no       | Bearer token the admin API requires; off when unset. |
| `PORT`                  | no       | Listen port. Defaults to `3000`.                     |

Migrations run on startup, tracked in `schema_migrations`.

## HTTP API

The dashboard is HTML at `/`; the JSON API lives under `/api`. Ingestion and the
admin API are authenticated with `Authorization: Bearer …`.

| Method | Path                                   | Purpose                                                         |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/api/health`                          | Liveness.                                                       |
| `POST` | `/api/admin/users`                     | Add a User, mint their token once (admin token).                |
| `GET`  | `/api/admin/users`                     | List Users with their identity fields (admin token).            |
| `POST` | `/api/admin/users/:id/revoke`          | Revoke a User's token (admin).                                  |
| `POST` | `/api/events`                          | Ingest a batch of `NormalEvent`s; `202`.                        |
| `GET`  | `/api/sessions`                        | List Sessions with owner, Turn count, and cost.                 |
| `GET`  | `/api/sessions/:id`                    | One Session with its Turns, child Sessions, and cost.           |
| `GET`  | `/api/sessions/:id/events?since_seq=N` | Events with sequence greater than `N`.                          |
| `GET`  | `/`                                    | Dashboard: the Sessions table.                                  |
| `GET`  | `/sessions/:id`                        | Dashboard: one Session's Turn tree, live Events, and Subagents. |

The admin plane requires the `Authorization: Bearer …` admin token. Creating a
User returns their token exactly once; the Server stores only its hash, so the
token is never retrievable again. Revoking it rejects the User's next ingestion
attempt.

Ingestion attributes every Event to the token's User, dedupes retries by Event
id, and assigns a per-Session monotonic `event_seq`.

A manager or DRI follows a Session live without refetching it: the Session page
appends Events by polling `GET /api/sessions/:id/events?since_seq=N` every ~5s and
on tab focus. `N` starts at the Session's sequence when the page loaded, so each
poll returns only the increment. The `events` query is unauthenticated (like the
rest of the read surface) and does not lock the Session, so a Session still being
written to keeps advancing the view.

A Subagent is a Session whose `parent_session_id` names its spawning Session and
whose `spawned_by_turn_id` names the Turn that launched it. The parent's detail
lists its child Sessions, each readable on its own with its own Turns and cost,
which is never folded into the parent's.

## Tests

Tests drive the real Server over HTTP against a real Postgres, and never reach
into its internals. Each run creates a throwaway database and drops it after.

```sh
bun run pg:up     # start Postgres (docker), reused by tests
bun test
bun run pg:down

# or point at your own instance:
SLOPWATCH_TEST_DATABASE_URL=postgres://user:pass@host/maintenance_db bun test
```

Without a reachable Postgres the HTTP tests skip with a warning, so `bun test`
stays green on a bare machine. CI runs Postgres as a service (see
`.github/workflows/ci.yml`).

## Known gaps (deferred to later tickets)

- Reads (the dashboard and `/api/sessions`) are unauthenticated. Org-wide
  visibility is the v1 model, but a real sign-in flow is not built yet.
- The admin plane is create-User, list-Users, and revoke-token. Re-minting a
  token for a User whose token was revoked is not built yet.
- The rollup tables, the leaderboard, and org-level spend are not built yet.
  Model requests are projected and cost is reported per Session and Turn.
