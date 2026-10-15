# Spec: Slopwatch v1

Status: ready-for-agent

## Problem Statement

An engineering org runs coding agents (OpenCode, and later Claude Code, Codex CLI, Pi, Copilot CLI) across its developers. Today that work is invisible.

The org cannot answer basic questions. Which coding agent Sessions ran today? What did they cost? Who is spending the most, on what model, on what work? What is happening right now, in a Session someone is watching live? Which Turn in a Session burned most of the money? When a coding agent was spawned as a Subagent, how did it behave?

Each developer could answer a slice of this by reading their own transcripts, but the transcripts are per-machine, per-agent, in five undocumented and drifting formats. Nothing aggregates them. Nothing links spend to work. Nothing shows a manager or DRI what is running.

The usual fix is a SaaS observability product, which is unacceptable: coding agent Sessions contain source code, prompts, and internal context. An org that refuses to ship that data to a vendor has no option today.

## Solution

Slopwatch is a self-hosted, on-prem platform. The org operates a single **Server** binary plus a Postgres instance it controls; data never leaves the org's infrastructure. Every coding agent is covered by a **Listener**, the per-agent component that observes the coding agent on the developer's machine, normalizes what it sees into **Events**, and ships them to the Server.

Developers onboard with one command and a token an admin hands them. From then on, their coding agent Sessions are captured automatically, with no always-on daemon, and become visible org-wide by default. The Server stores Events in Postgres and serves a dashboard: a Live Sessions table, a per-session Turn DAG, and a Developer leaderboard ranked by today's spend with an hourly sparkline per User. A manager or DRI can spectate a running Session, refreshed by polling every ~5s.

## User Stories

### Developer (a User running a coding agent)

1. As a developer, I want my coding agent's Sessions captured without changing how I work, so that observability costs me no new habits.
2. As a developer, I want setup to be a single command, so that I never hand-edit five different hook config files.
3. As a developer, I want to authenticate once with a token, so that I am not re-authenticating every Session.
4. As a developer, I want my token stored in the OS keychain, so that it is not sitting in plaintext on my machine.
5. As a developer, I want capture to work on a headless Linux box, so that servers and CI-run coding agents are covered too, with a 0600 file fallback.
6. As a developer, I want the Listener to exist only for the duration of a Session, so that my machine has no always-on bolted-on daemon.
7. As a developer, I want the Listener to be launched by the coding agent's own lifecycle, so that forgetting to start it is impossible.
8. As a developer, I want two concurrent Sessions to each be captured independently, so that running two coding agents at once is not lossy.
9. As a developer, I want Session events to be attributed to me because of my token, so that I do not have to trust or configure identity per Session.
10. As a developer, I want to view my own Sessions in the dashboard, so that I can understand my own usage and cost.
11. As a developer, I want capture to survive a Server outage without losing my Session, so that a brief network problem is not a data loss event.

### Manager / DRI (a User reviewing Sessions)

12. As a manager, I want a Live Sessions table, so that I can see what is running right now.
13. As a manager, I want a running Session's Events to refresh every ~5s, so that I can spectate a Session as it happens.
14. As a manager, I want the live view to refresh when I focus the tab, so that I am not looking at stale data after switching away.
15. As a manager, I want spectate to fetch only Events after the last one I saw, so that I am not re-downloading a whole Session every 5 seconds.
16. As a manager, I want spectate to keep working while a Session is still being written to, so that a long Turn does not freeze the view.
17. As a DRI, I want a leaderboard ranked by today's spend, so that "who is spending the most" is answered on sight.
18. As a DRI, I want spend shown alongside Session, Turn, and Model request counts, so that I can pick the granularity that matches my question.
19. As a DRI, I want a 24-point hourly sparkline per User, so that I can see the shape of someone's day.
20. As a DRI, I want a 7-day spend delta per User, so that I can see trend rather than a snapshot.
21. As a DRI, I want each User's top coding agent shown as a chip, so that I can see tool mix without an unreadable five-column table.
22. As a DRI, I want each User's name, handle, and team, so that I know who a row refers to.
23. As a DRI, I want to click a leaderboard row to see that User's Sessions, so that I can go from "who" to "what".
24. As a DRI, I want a Session detail view listing its Turns, so that I can understand what actually happened.
25. As a DRI, I want each Turn's cost and Model request count, so that I can find the expensive Turn.
26. As a DRI, I want each Turn's user prompt and assistant response, so that I can read the work without opening a raw transcript.
27. As a DRI, I want a Session's Subagents listed as child Sessions, so that I can ask how a specific spawned coding agent behaved.
28. As a DRI, I want a Turn to show the Model requests inside it, so that I can separate "one expensive call" from "many cheap calls".
29. As a DRI, I want a branching Session's Turn structure preserved, so that a non-linear coding agent is not flattened into a lie.
30. As a DRI, I want a spend-by-agent breakdown at org level, so that I can see where money goes per tool.
31. As a DRI, I want to search Sessions and Users, so that I can jump to a specific one.
32. As a DRI, I want the original raw agent payload retained per Event, so that I can debug a normalization gap.

### Admin (the User operating the Server)

33. As an admin, I want to deploy one binary pointed at a Postgres URL, so that standing up the Server is a single command.
34. As an admin, I want Postgres to be a separate deployable I operate, so that the database outlives application upgrades and can be backed up independently.
35. As an admin, I want schema migrations to run on startup, so that upgrading does not require hand-run SQL.
36. As an admin, I want to add a User by name and email, so that every captured Event traces to a real person.
37. As an admin, I want the Server to mint a long-lived bearer token per User, so that onboarding needs no self-service signup flow.
38. As an admin, I want to hand a token to a developer out-of-band, so that I control who is enrolled.
39. As an admin, I want to revoke a User's token, so that a departed developer immediately stops shipping Events.
40. As an admin, I want to see system health, so that I can tell whether ingestion is backed up or failing.
41. As an admin, I want the Server to be stateless, so that any replica can serve any query and I can scale horizontally later.
42. As an admin, I want the dashboard bundled into the Server binary, so that I do not deploy a second service.
43. As an admin, I want Session data to never leave the org's infrastructure, so that I can offer this to developers who would refuse a vendor.

### Listener author (maintaining per-agent capture)

44. As a Listener author, I want one shared Event schema, so that every coding agent normalizes into the same shape and the Server stays agent-agnostic.
45. As a Listener author, I want a typed client for shipping Events, so that my integration is checked at compile time.
46. As a Listener author, I want to ship a batch of Events in one request, so that capture is not one HTTP call per Event.
47. As a Listener author, I want ingestion to be idempotent, so that a retry after a failed response does not duplicate data.
48. As a Listener author, I want to know when the Server rejects my Events, so that a drifting agent schema surfaces loudly instead of silently dropping data.
49. As a Listener author, I want the capture surface per coding agent to be my choice, so that I can use JSONL tailing for one agent and an in-process extension for another.

### The Server as an integration point

50. As the Server, I want a per-Session monotonic event sequence, so that incremental polling is correct and gap-free.
51. As the Server, I want to reject unauthenticated ingestion, so that captured data cannot be spoofed.
52. As the Server, I want to derive the User from the token rather than the payload, so that a modified Listener cannot claim to be someone else.
53. As the Server, I want to store the raw agent payload alongside the normalized Event, so that fidelity is preserved for later re-normalization.
54. As the Server, I want to record which coding agent and version produced an Event, so that drift is diagnosable after the fact.

## Implementation Decisions

### Vocabulary

The spec uses `CONTEXT.md` terms throughout: **Session**, **Turn**, **Model request**, **Subagent**, **Listener**, **Server**, **User**, **Event**, `NormalEvent`. Notably a Turn is a user message plus the full assistant response including tool-use loops, and a Model request is one HTTP call to a provider inside a Turn.

### Modules

Three existing workspaces, all currently stubs:

- **`@slopwatch/events`** gains the real `NormalEvent` schema and the typed Listener to Server client. This is the shared contract and is the one piece both the Server and every Listener depend on.
- **`@slopwatch/server`** gains the HTTP API, the Postgres schema and migrations, and the dashboard.
- **`@slopwatch/listener-opencode`** gains the first real Listener. The placeholder Listener workspace is replaced rather than kept alongside a new one; the other coding agents are deferred, so a stub for one of them is dead weight.

ADR-0001 fixes the runtime for all three: Bun for development, tests, and shipping. That ADR's own consequence clause requires validating four Bun surfaces before significant code is written against them. With OpenCode as the only Listener, this spec depends on two of the four: the `pg` client and OS keychain access. File-watching and local IPC are not touched, because the OpenCode Listener is an in-process plugin that neither tails a file nor opens a local socket. Those two surfaces defer with the Codex and Copilot Listeners. Validating the two in use is the first unit of work, and a failure there reopens the ADR rather than being worked around.

### Event schema

`NormalEvent` becomes a discriminated union on a `kind` field, replacing the current `{ kind: "stub" }` placeholder. The categories come from the ingestion research and are carried as distinct variants: Session lifecycle, Turn, Message, Tool event, Model request, and raw-payload retention.

The schema carries a coding agent identifier and coding agent version on every Event, because schema drift is a certainty rather than a risk. The raw original payload is retained on the Event rather than discarded, so normalization bugs can be diagnosed and, in principle, replayed.

The typed client exposes a batched ship operation. The existing `sendEvents` export is the seam to build on; it currently throws.

### Authorization

Bearer tokens only. No OIDC in v1, per the architecture decisions. An admin creates a User and the Server mints a long-lived token, stored hashed at rest and shown once. Listeners send it as an `Authorization: Bearer` header.

The Server derives the acting User from the token. The payload never asserts identity, which is the point: "whose Session is this" is the question the product exists to answer, so it cannot be client-claimed.

### HTTP API

The Server is stateless HTTP over Postgres. The contract, as used by both the dashboard and the Listeners:

- Ingestion: a batched authenticated POST accepting `NormalEvent[]`, returning 202. Idempotent per Event so retries are safe.
- Live Sessions: list Sessions filtered by active status, User, and limit.
- Session detail: one Session, its Turns, and its child Sessions (Subagents).
- Incremental Events: `GET /sessions/:id/events?since_seq=N` returning Events with a sequence greater than `N`. This is the one contract the live-spectate feature rests on.
- Leaderboard: per-User aggregates for a window, carrying spend, Session count, Turn count, Model request count, top coding agent, hourly sparkline, and 7-day delta.
- Spend by agent: org-level totals per coding agent.
- Admin: create User (returns token once), revoke token, list Users.
- Health.

Polling is the transport for liveness. No SSE, no WebSocket, no LISTEN/NOTIFY. The architecture decision fixes this at ~5s with a refresh on tab focus.

### Postgres schema

Core tables: `users`, `tokens`, `sessions`, `turns`, `model_requests`, and `events`.

`sessions` carries the coding agent, coding agent version, cwd, the owning User, start and end, `parent_session_id` and `spawned_by_turn_id` for Subagents, and a per-Session monotonic `event_seq`. Subagents are child Sessions rather than Turns folded into the parent, so "how is my Explore subagent behaving" stays answerable.

`turns` carries `parent_turn_id` so a branching coding agent is represented as a real DAG inside one Session, while linear agents produce a degenerate linear DAG for free.

Rollups: `user_hourly_rollup` and `user_daily_rollup`. **This spec commits to the rollup tables rather than computing sparklines and deltas on demand.** The leaderboard design requires 24 hourly points plus a 7-day delta per User; computing that on demand from `model_requests` does not survive an org-scale roster. The tables are maintained by upsert on ingest and are recomputable from `model_requests`, so they are a cache, not a second source of truth.

### Dashboard

**This spec makes a call the architecture document left open.** The frontend stack is unresolved there. To keep the single-binary deployment shape and the single test seam intact, the dashboard is server-rendered HTML served by the Server, with small progressive-enhancement JavaScript for the polling live view. No separate SPA build, no client-side router, no second deployable. This satisfies the "bundled static assets" constraint without reopening the frontend question.

The dashboard surfaces, in v1: a Live Sessions table, a Session detail view with the Turn DAG, a Developer leaderboard, and a spend-by-agent breakdown. The leaderboard follows the design in `research/developer-leaderboard-design.md`: sorted by today's spend descending, dense and balanced and sparse densities, tabular numerals, mono identifiers.

### OpenCode Listener

The first Listener. The capture surface is OpenCode's first-class plugin API: an in-process TypeScript plugin loaded into OpenCode itself, subscribing to session, message, and tool-execution events and shipping normalized Events directly to the Server. There is no subprocess and no read of on-disk state.

That last point is not a preference. OpenCode's on-disk storage is migrating from JSON files to SQLite, which breaks any file tailer. The plugin API is the stable contract, and it is also the richer one: tool-execution hooks can be observed before and after the fact, and model requests are visible at the parameters level.

The plugin runs inside OpenCode's own JavaScript runtime and is loaded by OpenCode's lifecycle, so there is no always-on daemon and no "the developer forgot to start it" failure mode. Because it shares a runtime with the coding agent, a Listener defect risks destabilising the developer's coding agent in a way a separate process would not. The plugin therefore does no work on the agent's critical path and never throws into the host.

OpenCode's schema has changed shape several times. The Listener detects unrecognized event shapes and fails loudly rather than silently dropping Turns.

### Offline behaviour

The architecture document lists Listener buffering as an open question. This spec settles the minimum: a bounded local append-only spool that the Listener drains on reconnect, with a documented cap and a loud warning when the cap is hit. Silent truncation is not acceptable, because a dropped Turn reads as "the developer did nothing."

## Testing Decisions

### The seam

**One seam: the Server's HTTP API, running against a real Postgres.** There is no second seam.

This is the highest point in the system and everything crosses it. Listeners POST Events in; the dashboard and live-spectate poll out; admin mints and revokes tokens. Testing here means testing the whole spine through its public contract, and it covers the one thing that would otherwise go untested: the SQL. The load-bearing logic in this product is SQL-shaped, notably the per-Session monotonic `event_seq`, the `since_seq` incremental-poll contract, JSONB raw payload retention, and the rollup upserts. Mocking Postgres would test none of that.

Tests boot a real Postgres (Docker is available in this environment), apply migrations, and drive the Server over HTTP. Database state is reset between tests.

### What a good test looks like here

Tests assert only externally observable behaviour: HTTP requests in, HTTP responses out, and the state those requests produce as observed through further requests. A test never reaches into the Server's internals, never imports its modules directly, and never inspects table rows directly. If a behaviour cannot be observed through the API, that is a signal the API is missing something, not a signal to reach around it.

Tests are named using `CONTEXT.md` vocabulary (Session, Turn, Model request, Subagent, Event), not ad-hoc synonyms. The glossary explicitly avoids "conversation", "message", "API call", and similar; the tests should not reintroduce them.

### Coverage

Through the single seam:

- **Ingestion and identity.** Authenticated batched POST; unauthenticated and revoked-token POSTs rejected; Events attributed to the token's User regardless of payload claims; retries idempotent.
- **Sequencing.** `event_seq` monotonic per Session under concurrent ingestion; `since_seq` returns exactly the right increment and no gaps.
- **Session and Turn shape.** A Session with Turns and Model requests round-trips; a branching Session round-trips as a DAG; a Subagent round-trips as a child Session linked to its spawning Turn.
- **Rollups.** The leaderboard endpoint returns spend, counts, top coding agent, 24 hourly points, and 7-day delta consistent with the Model requests ingested.
- **Admin.** Token mint, token revoke, and the resulting authorization change.
- **OpenCode Listener, through this same seam.** Recorded OpenCode plugin events are replayed into the Listener, which POSTs to the real Server; assertions are made against the API. This keeps the seam count at one: normalization is verified by what lands in the Server, not by inspecting the Listener's internals. Fixtures include recorded events and an unrecognized event shape, the latter asserting a loud failure rather than silent data loss.

### Prior art

There is none yet. `apps/server/src/index.test.ts` and `packages/events/src/index.test.ts` assert that a stub object equals itself. This spec establishes the pattern for the repo: real Postgres, real HTTP, no mocks. Whatever fixture-loading and database-reset helpers the first tests need become the prior art for every test after them.

## Out of Scope

- **The DRI review model.** The architecture document records that the design interview exited before resolving whether a DRI is a queryer over a firehose or a recipient of routed Sessions. That choice changes the schema materially (review comments, review state, routing), so it is deferred rather than guessed. The leaderboard and Session views are read-only in v1.
- **The other four Listeners.** Claude Code, Codex CLI, Pi, and Copilot CLI are the same spine, requiring one Listener each against the shared `NormalEvent` contract. Each is follow-on work, not a separate design. Pi is another in-process extension; Claude Code, Codex, and Copilot are transcript-and-hooks captures, which is what brings file-watching and local IPC back onto the list of Bun surfaces to validate.
- **Resumes.** Coding agent resume and compaction-continue semantics are explicitly deferred by the architecture document until v1 is running on real data.
- **OIDC.** Admin-minted bearer tokens only.
- **Retention and pruning.** No TTL, no archival, no per-team policy.
- **Proxy capture.** Not a v1 path for any coding agent.
- **OpenTelemetry ingestion.** Not used as a capture path in v1.
- **Push notifications.** No email, no Slack. Notifications are pull-only.
- **Multi-team scoping and a first-class `Team` entity.** Team is a plain field on a User in v1, as the leaderboard design concedes.
- **Cost normalization across providers.** Token-to-dollar normalization for cached and reasoning tokens is its own project; v1 stores what the agent reports.
- **Advancing the install flow beyond the minimum needed to wire up the OpenCode Listener.**

## Further Notes

- **Two decisions here fill gaps the architecture document left open**: the server-rendered dashboard, and the rollup tables. Both are recorded as decisions above rather than left implicit. Neither contradicts an ADR.
- **ADR-0001 is load-bearing for this spec.** Its consequence clause names four Bun surfaces to validate before significant code is written: the `pg` client, file-watching, local IPC, and OS keychain access. With OpenCode as the only Listener this spec touches two of them, the `pg` client and OS keychain access, and the other two are deferred rather than validated speculatively. Validating the two in use is the first unit of work, and a failure there reopens the ADR rather than being worked around.
- **The three research documents contain superseded decisions.** `research/v1-architecture-decisions.md` notes that it uses "sidecar" and "backend" for what `CONTEXT.md` now calls Listener and Server. Treat the glossary as authoritative.
- **The live-spectate latency was deliberately downgraded** from ~100ms fs-watch to 5s polling. The ingestion research still describes the ~100ms fs-watch figure as acceptable. For the Server-facing contract, the 5s polling decision wins; for the Listener's local tailing, lower latency is harmless and not a contract.
