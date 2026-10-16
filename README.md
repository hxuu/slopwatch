# Slopwatch

[![CI](https://github.com/hxuu/slopwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/hxuu/slopwatch/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)

Self-hosted, on-prem observability for coding agents. Slopwatch observes the
Sessions a developer runs in Claude Code, Codex, Pi, OpenCode, and Copilot, ships
them to a Server you operate, and turns them into answers about who spent what,
on which model, across which Turns.

Agents are opaque today: a Session is a black box that ends with a dollar figure.
Slopwatch opens the box. Every Turn, tool call, and Model request is normalized
into one schema, stored in Postgres you control, and read back through a
dashboard.

> [!NOTE]
> Slopwatch is a team tool, not a SaaS. There is one deployment mode:
> self-hosted, on-prem, one Server per organization. Data never leaves your
> infrastructure, and visibility is org-wide by design. Solo use is just a team
> of one.

## How it works

```
 Developer machine                        Org-operated, self-hosted
 ┌──────────────────────────────┐         ┌──────────────────────────────┐
 │ Coding agent                 │         │ slopwatch-server             │
 │ (Claude Code, Codex, Pi,     │         │ (single binary)              │
 │  OpenCode, Copilot)          │         │  - HTTP API + dashboard      │
 │      │                       │         │  - stateless                 │
 │      ▼                       │         │          │                   │
 │ slopwatch Listener           │──POST──▶│          ▼                   │
 │ (per-agent integration,      │ Events  │    Postgres (separate,       │
 │  in-process or subprocess)   │◀─poll───│    org-operated)             │
 └──────────────────────────────┘         └──────────────────────────────┘
                                                       ▲
                                                       │ polling
                                                       │ GET /api/sessions/:id/events
                                              ┌────────┴────────┐
                                              │ Browser (DRI,   │
                                              │ manager, dev)   │
                                              └─────────────────┘
```

Two components do the work:

- **Listener** - a per-agent integration on the developer's machine that observes
  one coding agent, normalizes its events into `NormalEvent`, and ships them to
  the Server. One Listener per supported agent; it runs either in-process (Pi,
  OpenCode) or as a per-session subprocess (Claude Code, Codex, Copilot).
- **Server** - the single self-hosted process that receives Events, stores them
  in Postgres, serves the dashboard, and hosts the admin plane. It is the only
  component that talks to Postgres.

Listeners and the Server share one contract: `@slopwatch/events`, which defines
the `NormalEvent` schema and the typed Listener-to-Server client.

## Features

- **Session capture** - Turns, Messages, tool calls and results, and Model
  requests, all normalized across agents into one schema. Each Model request
  keeps its provider, model, token counts, latency, and reported cost.
- **Subagents as first-class Sessions** - a Session spawned by another (for
  example OpenCode's `task` tool) is linked to its parent and reviewed on its own,
  with its own Turns and cost.
- **Live spectate** - watch a running Session without refetching it. The detail
  page polls for Events past a sequence number and refreshes on tab focus.
- **Leaderboard and spend** - Users ranked by the day's spend, org spend split by
  coding agent, and per-Session and per-Turn cost.
- **Search** - find Sessions by id, cwd, or agent, and Users by name or email.
- **Raw payload retention** - every Event keeps the original agent payload
  unmodified, so schema drift can be diagnosed and replayed.
- **Enforced identity** - ingestion attributes every Event to the bearer token's
  User; the payload never asserts identity.
- **Offline spool** - a Listener that cannot reach the Server buffers a bounded,
  append-only batch and ships it in order once the Server returns.

## Dashboard

The Server serves the dashboard itself, so there is no separate frontend to
build or deploy. Every Session, newest first, with its owner, coding agent,
working directory, status, and Turn count:

![Sessions dashboard](docs/assets/dashboard-sessions.webp)

The Leaderboard ranks Users by the day's spend, with an hourly sparkline, each
User's top coding agent, and their Session, Turn, and Model-request counts:

![Leaderboard](docs/assets/dashboard-leaderboard.webp)

## Repository layout

A Bun workspace monorepo.

| Package               | What it is                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| `apps/server`         | `@slopwatch/server` - the self-hosted Server and dashboard.              |
| `listeners/opencode`  | `@slopwatch/listener-opencode` - the first Listener, an OpenCode plugin. |
| `packages/events`     | `@slopwatch/events` - the `NormalEvent` schema and the shipping client.  |
| `spikes/bun-surfaces` | Throwaway proof that the Bun surfaces v1 depends on work (ADR-0001).     |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) - the runtime and toolchain for everything.
- A Postgres 17 instance. Docker makes this one command.

### Install

```sh
bun install
```

### Run the Server

```sh
cd apps/server

bun run pg:up                                   # Postgres on 127.0.0.1:55433 (docker)
DATABASE_URL=postgres://slopwatch:slopwatch@127.0.0.1:55433/slopwatch \
SLOPWATCH_ADMIN_TOKEN=$(openssl rand -hex 16) \
  bun run dev
```

Migrations run on startup, tracked in `schema_migrations`. The dashboard is at
`http://localhost:3000`.

To ship it, `bun run build` compiles the Server, its migrations, and the
dashboard's HTML, CSS, and JavaScript into one binary at `dist/slopwatch`.
`DATABASE_URL` is the only thing it needs at runtime, and a binary upgrade is
drop-in: point the new binary at the same database and it applies only the
migrations the previous release had not.

### Add a User

The admin plane requires the admin token set above. Creating a User mints a
token exactly once.

```sh
curl -X POST http://localhost:3000/api/admin/users \
  -H "Authorization: Bearer $SLOPWATCH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com"}'
# => { "id": "...", "name": "Ada Lovelace", "email": "...", "token": "..." }
```

> [!WARNING]
> The Server stores only a hash of the token, so the response above is the only
> time it is shown. Hand it to the developer out-of-band. Revoking it rejects
> their next ingestion attempt.

### Load the OpenCode Listener

The first Listener is an in-process OpenCode plugin. List the package in
`opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@slopwatch/listener-opencode"],
}
```

Point it at the Server and the minted token, either as plugin options (`url` /
`token`) or through the environment:

| Source             | Key             | Meaning                                         |
| ------------------ | --------------- | ----------------------------------------------- |
| plugin options     | `url` / `token` | The Server base URL and the bearer token.       |
| `SLOPWATCH_URL`    |                 | Defaults to `http://localhost:3000`.            |
| `SLOPWATCH_TOKEN`  |                 | Overrides the stored token.                     |
| OS keychain / file | `token`         | Where `slopwatch login` (later ticket) puts it. |

With no token the Listener reports itself inactive and does nothing, so a
developer without Slopwatch is left undisturbed.

> [!TIP]
> `bun run pg:up` starts the same Postgres the tests use, so there is no second
> instance to manage. Tear it down with `bun run pg:down`.

## Development

Run everything from the repository root.

| Command             | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `bun run ci`        | Format check, type check, and tests - what CI runs. |
| `bun run test`      | Tests across every workspace package.               |
| `bun run typecheck` | Type check every package with `tsgo`.               |
| `bun run build`     | Compile the Server to a single binary.              |
| `bun run format`    | Format with Prettier.                               |

Tests drive real systems over real seams: the Server over HTTP against a real
Postgres, and the OpenCode Listener by replaying recorded plugin events into a
real Server and reading back over `/api/sessions`. Each run creates a throwaway
database and drops it after. Without a reachable Postgres the HTTP tests skip
with a warning, so `bun test` stays green on a bare machine.

```sh
bun run pg:up     # start Postgres (reused by tests)
bun run test
bun run pg:down
```

Or point at your own instance:

```sh
SLOPWATCH_TEST_DATABASE_URL=postgres://user:pass@host/maintenance_db bun run test
```

## Configuration

Server environment variables:

| Variable                | Required | Meaning                                              |
| ----------------------- | -------- | ---------------------------------------------------- |
| `DATABASE_URL`          | yes      | Postgres the Server migrates and reads/writes.       |
| `SLOPWATCH_ADMIN_TOKEN` | no       | Bearer token the admin API requires; off when unset. |
| `PORT`                  | no       | Listen port. Defaults to `3000`.                     |

The dashboard is HTML at `/`; the JSON API lives under `/api`. Reads are
unauthenticated in the current v1 model (org-wide visibility); ingestion and the
admin API require `Authorization: Bearer ...`.

## Documentation

- [CONTEXT.md](./CONTEXT.md) - the glossary. The authoritative definitions of
  Session, Turn, Model request, Cost, Listener, and Server.
- [docs/adr](./docs/adr) - architecture decision records.
- [research/v1-architecture-decisions.md](./research/v1-architecture-decisions.md) -
  the resolved decisions and open questions behind v1.
- [research/coding-agent-ingestion.md](./research/coding-agent-ingestion.md) -
  capture surfaces across the five target agents.
- [research/developer-leaderboard-design.md](./research/developer-leaderboard-design.md) -
  the dashboard's top-level "who is spending" surface.
