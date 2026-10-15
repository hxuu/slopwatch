import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe } from "bun:test";
import { Client } from "pg";
import { startServer } from "../server";

/**
 * Where the maintenance Postgres lives. Tests create and drop a throwaway
 * database per server from this one.
 */
export const MAINTENANCE_DATABASE_URL =
  process.env.SLOPWATCH_TEST_DATABASE_URL ??
  "postgres://slopwatch:slopwatch@127.0.0.1:55433/slopwatch";

let databaseCounter = 0;

/** Whether the maintenance Postgres is reachable at all. */
export async function postgresReachable(): Promise<boolean> {
  const client = new Client({
    connectionString: MAINTENANCE_DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const postgresAvailable = await postgresReachable();
if (!postgresAvailable) {
  console.warn(
    "[server] skipping HTTP tests: no Postgres at " +
      `${MAINTENANCE_DATABASE_URL}. Run \`bun run pg:up\`.`,
  );
}

/**
 * Declare a suite that runs against one real Server and Postgres, reset between
 * tests. The suite is skipped with a warning when no Postgres is reachable, so
 * `bun test` stays green on a bare machine. `server` is a getter: each test asks
 * for the running handle rather than capturing it at collection time.
 */
export function describeServer(
  title: string,
  define: (server: () => TestServer) => void,
): void {
  describe.skipIf(!postgresAvailable)(title, () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startTestServer();
    });

    afterAll(async () => {
      await server?.stop();
    });

    beforeEach(async () => {
      await server.reset();
    });

    define(() => server);
  });
}

/**
 * A running Server backed by its own throwaway database. Tests drive it over
 * HTTP; nothing here reaches into the Server's internals.
 */
export interface TestServer {
  readonly url: string;
  readonly adminToken: string;
  /** Mint a User through the admin API, returning their bearer token. */
  createUser(
    name: string,
    email: string,
  ): Promise<{ id: string; name: string; email: string; token: string }>;
  /** Truncate every application table, giving each test a clean slate. */
  reset(): Promise<void>;
  /** Stop the Server and drop its database. */
  stop(): Promise<void>;
}

/** Boot a real Server against a fresh, migrated Postgres database. */
export async function startTestServer(): Promise<TestServer> {
  const adminToken = `slop_admin_${randomUUID()}`;
  const databaseName = `slopwatch_test_${process.pid}_${Date.now().toString(36)}_${databaseCounter++}`;

  const maintainer = new Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await maintainer.connect();
  await maintainer.query(`create database "${databaseName}"`);
  await maintainer.end();

  const databaseUrl = withDatabase(MAINTENANCE_DATABASE_URL, databaseName);
  const handle = await startServer({ databaseUrl, adminToken, port: 0 });

  return {
    url: handle.url,
    adminToken,

    async createUser(name, email) {
      const response = await fetch(`${handle.url}/api/admin/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name, email }),
      });
      if (!response.ok) {
        throw new Error(
          `could not create User: ${response.status} ${await response.text()}`,
        );
      }
      return (await response.json()) as {
        id: string;
        name: string;
        email: string;
        token: string;
      };
    },

    async reset() {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query(
        "truncate users, tokens, sessions, turns, events, model_requests, " +
          "user_daily_rollup, user_hourly_rollup cascade",
      );
      await client.end();
    },

    async stop() {
      await handle.stop();
      const maintainer = new Client({
        connectionString: MAINTENANCE_DATABASE_URL,
      });
      await maintainer.connect();
      await maintainer.query(
        `drop database if exists "${databaseName}" with (force)`,
      );
      await maintainer.end();
    },
  };
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
