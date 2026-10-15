# `@slopwatch/listener-opencode`

The first Listener: an in-process OpenCode plugin that observes a developer's
OpenCode Sessions and ships normalized Events to the Server.

It is a plugin, not a daemon. OpenCode loads it through its own lifecycle and
dispatches events to it, so there is no always-on process and no "the developer
forgot to start it" failure mode. It never reads OpenCode's on-disk storage: the
store is mid-migration from JSON to SQLite, while the plugin API is the stable
contract.

## Load it

List the package in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@slopwatch/listener-opencode"],
}
```

Configuration is read from plugin options, then the environment:

| Source             | Key             | Meaning                                           |
| ------------------ | --------------- | ------------------------------------------------- |
| plugin options     | `url` / `token` | The Server's base URL and the bearer token.       |
| `SLOPWATCH_URL`    |                 | Defaults to `http://localhost:3000`.              |
| `SLOPWATCH_TOKEN`  |                 | Overrides the stored token.                       |
| OS keychain / file | `token`         | Where `slopwatch login` (a later ticket) puts it. |

With no token the Listener reports that it is inactive and does nothing, so a
developer without Slopwatch is left undisturbed.

## What it captures

The plugin subscribes to OpenCode's public event stream and normalizes:

- `session.created` / `session.deleted` into `session.started` / `session.ended`
- `session.inbox.enqueued` and OpenCode's step, text, and execution events into
  Turns and their Model requests
- `session.tool.*` into `tool.call` / `tool.result`

OpenCode names a Turn by its assistant message id, so that id is the Turn id
every Tool event and Model request in the Turn carries.

OpenCode's schema has drifted before. A handled event whose payload no longer
matches is reported loudly rather than dropped in silence; unrelated event types
(tui, pty, shell) are ignored on purpose.

## Two rules that shape the code

- **Off the critical path.** The subscription runs in its own loop and only
  normalizes synchronously; shipping happens in the background.
- **Never throw into the host.** The plugin shares a runtime with the coding
  agent, so every failure is reported and swallowed.

The token store lives in `src/token.ts`: the OS keychain, with a 0600 file
fallback for headless Linux. It is the productionized form of the store
validated on Bun in `spikes/bun-surfaces` (ADR-0001).

## Tests

The Listener is tested through the Server's HTTP API, the system's one seam:
recorded OpenCode plugin events in `src/test/fixtures.ts` are replayed into the
Listener, which POSTs to a real Server, and the assertions read back over
`/api/sessions*`. A real Postgres is required, as for the Server's own tests:

```sh
bun run --cwd ../../apps/server pg:up
bun test
```

Without a reachable Postgres the end-to-end tests skip with a warning.
