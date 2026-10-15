# Bun surfaces validation

Validation spike for the two Bun surfaces Slopwatch v1 depends on, as required by
[ADR-0001](../docs/adr/0001-bun-everywhere.md)'s consequence clause: the `pg` Postgres client, and
OS keychain access with a file fallback. The runnable proof lives in
[`spikes/bun-surfaces`](../spikes/bun-surfaces).

**Decision: GO.** ADR-0001 stands. No Bun-specific incompatibility was found on either surface, and
both work both under `bun run` and inside a `bun build --compile` binary. One library landmine was
found and must be pinned around; it is a `@napi-rs/keyring` default, not a Bun defect.

Date: 2026-10-15.

## Scope

Validated, because v1's OpenCode Listener touches them:

- The `pg` Postgres client: connect, query, clean teardown, and a connection failure.
- OS keychain access with a 0600 file fallback.

Not validated, deliberately:

- **File-watching and local IPC are explicitly out of scope.** The only v1 Listener is an in-process
  OpenCode plugin: it neither tails a file nor opens a local socket. Those two surfaces only come
  back with the Codex and Copilot Listeners, which are deferred. Validating them now would validate
  code nobody writes.

## Environment

| Component          | Version                                                    |
| ------------------ | ---------------------------------------------------------- |
| Bun                | 1.3.2                                                      |
| `pg`               | 8.23.1 (pure JS)                                           |
| PostgreSQL         | 17.11, `postgres:17-alpine` in Docker                      |
| `@napi-rs/keyring` | 2.1.1                                                      |
| Keychain           | gnome-keyring 51.1 over the Secret Service (D-Bus session) |
| OS                 | Arch Linux, kernel 7.2.9, x86-64                           |

## `pg` on Bun

Works, unmodified.

- Connected to a real Postgres 17.11, ran `select 1 + 1 as sum, version()`, got `2` and
  `PostgreSQL 17.11`, closed cleanly.
- A connection attempt to a dead port rejects with a plain `Error` carrying `code: "ECONNREFUSED"` on
  the error object, message `connect ECONNREFUSED 127.0.0.1:1`. The proof wraps that in a typed
  `PostgresConnectionError` so callers branch on the code rather than parse a string. The wrapping
  covers the connect phase only; a query that fails mid-flight propagates the driver error untouched,
  which is the Server's problem to handle when it has queries worth failing.
- After a failed connection, a fresh client still connects: the failed attempt leaks nothing and does
  not wedge the process.
- Worked identically inside a `bun build --compile` binary (`bun run compile && ./dist/proof`).

Not exercised, to revisit when the Server introduces them:

- **`pg.Pool`.** The Server will pool connections. `Pool` emits `error` events for idle clients that
  fail, and an unhandled `error` event terminates the process; that handler needs a deliberate
  decision. Out of scope for a connect/query/fail proof.
- TLS to Postgres, and `pg-native` (libpq via N-API), which v1 does not need.

## OS keychain on Bun

Works, with one default that must be overridden.

Binding chosen: `@napi-rs/keyring` 2.1.1. It ships prebuilt N-API binaries (no `node-gyp`), and it is
the maintained successor to the archived `keytar`.

- A set/get/delete round-trip through the Secret Service (gnome-keyring 51.1) succeeds on Bun.
- **Landmine: on Linux the default store selection silently falls back.** When no Secret Service is
  reachable, `@napi-rs/keyring` falls back to the in-memory kernel keyring (keyutils) rather than
  failing. The kernel keyring does not survive a reboot. A token would look stored, read back
  correctly for the rest of the session, and then vanish. Pinning
  `new Entry(service, account, { linux: { store: "secret-service" } })` makes an absent Secret
  Service throw instead, which is the signal to fall back to the file. Verified: with the D-Bus
  session address pointed at a nonexistent socket, the pinned constructor throws
  `Platform failure: DBus error: Failed to connect to socket ...`, while the unpinned one silently
  uses keyutils.
- Availability is therefore decided by whether an entry can be opened, not by probing D-Bus by hand.
  On macOS and Windows the default store is used and the constructor does not throw.
- **File fallback.** Writes `secrets.json` under `$XDG_CONFIG_HOME/slopwatch` (default
  `~/.config/slopwatch`), creates the directory `0700`, and forces the file to `0600` after every
  write. The forced `chmod` matters: `writeFile`'s `mode` is masked by the umask and ignored entirely
  when the file already exists. Verified under a hostile umask.
- Worked identically inside the same `bun build --compile` binary.

Not exercised:

- macOS Keychain (access prompts, locked keychain) and Windows Credential Manager. No machine of
  either in this spike.
- A Secret Service that is present but locked. The keychain module treats "cannot open an entry" as "no
  keychain"; a locked keychain throwing mid-write is currently surfaced rather than silently
  falling back, which is the honest failure but has not been seen in practice.

## Bun-specific observations

None of the above needed a Bun workaround. The one thing worth recording: `bun build --compile`
bundled the pure-JS `pg` and the N-API keyring addon into a single binary that still connected to
Postgres and used the keychain. The binary was ~107 MiB, which is the known cost of the
single-binary story and not a blocker for the Server.

## Consequences

- ADR-0001 is not reopened. `@slopwatch/server` can build on `pg`; the Listener's token store builds
  on `@napi-rs/keyring`, pinned to `secret-service`, with the 0600 file fallback. The spike's
  `keychain.ts` already has that shape.
- When the Server adopts a `Pool`, validate idle-client `error` handling before shipping.
- The spike's tests skip the Postgres proof when nothing is listening and the keychain proof when no
  keychain is present, so `bun test` stays green without Docker. The real test harness the spec calls
  for (Server over HTTP against a real Postgres) will need a Postgres service in CI instead of a skip.

## Reproduce

```sh
cd spikes/bun-surfaces
bun run pg:up      # postgres 17 on :55432, docker
bun run proof      # both surfaces, human-readable
bun test           # the same, as assertions
bun run compile && ./dist/proof   # both surfaces inside a single compiled binary
bun run pg:down
```
