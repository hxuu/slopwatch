import { describe, expect, test } from "bun:test";
import { PostgresConnectionError, probePostgres } from "./postgres";

// The proof runs against a real Postgres, started by `bun run pg:up` (see
// README.md). Tests that need it are skipped when it is not listening, so the
// suite stays green in an environment without Docker.
const databaseUrl =
  process.env.SLOPWATCH_SPIKE_DATABASE_URL ??
  "postgres://spike:spike@127.0.0.1:55432/spike";

async function isReachable(url: string): Promise<boolean> {
  try {
    await probePostgres({ connectionString: url });
    return true;
  } catch {
    return false;
  }
}

const databaseReachable = await isReachable(databaseUrl);
if (!databaseReachable) {
  console.warn(
    `[bun-surfaces] skipping Postgres proof: no server at ${databaseUrl}. Run \`bun run pg:up\`.`,
  );
}

describe("Postgres via pg on Bun", () => {
  test.skipIf(!databaseReachable)(
    "runs a query against a real Postgres",
    async () => {
      const result = await probePostgres({ connectionString: databaseUrl });

      expect(result.sum).toBe(2);
      expect(result.serverVersion).toStartWith("PostgreSQL");
    },
  );

  test("surfaces an unreachable server as a clean, typed error", async () => {
    const error = await probePostgres({
      connectionString: "postgres://spike:spike@127.0.0.1:1/spike",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PostgresConnectionError);
    expect((error as Error).message).toContain("127.0.0.1:1");
    expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });

  test.skipIf(!databaseReachable)(
    "stays usable after a failed connection attempt",
    async () => {
      await probePostgres({
        connectionString: "postgres://spike:spike@127.0.0.1:1/spike",
      }).catch(() => {});

      const result = await probePostgres({ connectionString: databaseUrl });
      expect(result.sum).toBe(2);
    },
    10_000,
  );
});
