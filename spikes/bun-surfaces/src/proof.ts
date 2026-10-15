/**
 * The proof ADR-0001 asks for: the two Bun surfaces Slopwatch v1 depends on,
 * exercised for real. Run against a live Postgres (`bun run pg:up`) and a real
 * keychain:
 *
 *   bun run proof
 *
 * Exits non-zero if either surface misbehaves. Findings are written up in
 * `research/bun-surfaces-validation.md`.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretStoreOptions, openSecretStore } from "./keychain";
import { PostgresConnectionError, probePostgres } from "./postgres";

const DEFAULT_DATABASE_URL = "postgres://spike:spike@127.0.0.1:55432/spike";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const databaseUrl =
  argument("database-url") ??
  process.env.SLOPWATCH_SPIKE_DATABASE_URL ??
  DEFAULT_DATABASE_URL;

let failed = false;
function report(label: string, detail: string): void {
  console.log(`  ${label.padEnd(22)} ${detail}`);
}
function fail(label: string, detail: string): void {
  failed = true;
  report(label, `FAIL ${detail}`);
}

async function provePostgres(): Promise<void> {
  console.log(`\nPostgres (pg) at ${databaseUrl}`);

  try {
    const probe = await probePostgres({ connectionString: databaseUrl });
    if (probe.sum !== 2) throw new Error(`select 1 + 1 returned ${probe.sum}`);
    report(
      "connect + query",
      `ok  ${probe.serverVersion}, select 1 + 1 = ${probe.sum}`,
    );
  } catch (thrown) {
    fail(
      "connect + query",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  }

  // Connection failure, against a port nothing listens on.
  try {
    await probePostgres({
      connectionString: "postgres://spike:spike@127.0.0.1:1/spike",
    });
    fail(
      "connection failure",
      "expected a failure but the connection succeeded",
    );
  } catch (thrown) {
    if (thrown instanceof PostgresConnectionError) {
      report(
        "connection failure",
        `handled cleanly: ${thrown.message} (code ${thrown.code})`,
      );
    } else {
      fail("connection failure", `not a clean error: ${String(thrown)}`);
    }
  }
}

async function proveKeychain(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "slopwatch-proof-"));
  const options: SecretStoreOptions = {
    service: "slopwatch-proof",
    filePath: join(scratch, "secrets.json"),
  };
  const store = await openSecretStore(options);
  console.log(`\nKeychain (backend: ${store.backend})`);

  try {
    await store.set("token", "proof-token");
    const read = await store.get("token");
    if (read !== "proof-token")
      throw new Error(`read back ${JSON.stringify(read)}`);
    report("round-trip", "ok  wrote and read back a secret");
  } catch (thrown) {
    fail(
      "round-trip",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  } finally {
    await store.delete("token");
  }

  // The fallback, forced by a keychain that reports itself unavailable.
  const filePath = join(scratch, "fallback.json");
  const noKeychain: SecretStoreOptions["keychain"] = () => {
    throw new Error("no Secret Service available");
  };
  const fallback = await openSecretStore({ filePath, keychain: noKeychain });
  try {
    if (fallback.backend !== "file")
      throw new Error(`backend is ${fallback.backend}`);
    await fallback.set("token", "fallback-token");
    const mode = statSync(filePath).mode & 0o777;
    if (mode !== 0o600)
      throw new Error(`file mode is 0o${mode.toString(8)}, want 0o600`);
    const reopened = await openSecretStore({ filePath, keychain: noKeychain });
    if ((await reopened.get("token")) !== "fallback-token")
      throw new Error("value did not persist");
    report("file fallback", `ok  0o600 file at ${filePath}`);
  } catch (thrown) {
    fail(
      "file fallback",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  }
}

console.log(`Bun surfaces proof (bun ${Bun.version}, ${process.platform})`);
await provePostgres();
await proveKeychain();
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: OK");
process.exit(failed ? 1 : 0);
