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

| Method | Path                                   | Purpose                                               |
| ------ | -------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/health`                          | Liveness.                                             |
| `POST` | `/api/admin/users`                     | Add a User, mint their token (admin token required).  |
| `POST` | `/api/events`                          | Ingest a batch of `NormalEvent`s; `202`.              |
| `GET`  | `/api/sessions`                        | List Sessions with owner, Turn count, and cost.       |
| `GET`  | `/api/sessions/:id`                    | One Session with its Turns, Model requests, and cost. |
| `GET`  | `/api/sessions/:id/events?since_seq=N` | Events with sequence greater than `N`.                |
| `GET`  | `/`                                    | Dashboard: the Sessions table.                        |
| `GET`  | `/sessions/:id`                        | Dashboard: one Session's Turns.                       |

Ingestion attributes every Event to the token's User, dedupes retries by Event
id, and assigns a per-Session monotonic `event_seq`.

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
- Admin is create-User only: revoke and list arrive with the admin ticket.
- The rollup tables, the leaderboard, and org-level spend are not built yet.
  Model requests are projected and cost is reported per Session and Turn.
