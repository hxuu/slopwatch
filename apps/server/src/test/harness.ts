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

/** Whether a real Postgres is reachable, so a suite can skip when it is not. */
export { postgresAvailable };

/** A throwaway database on the maintenance Postgres. */
export interface ThrowawayDatabase {
  readonly url: string;
  /** Drop the database, forcing any lingering connection closed. */
  drop(): Promise<void>;
}

/** Create an empty throwaway database, un-migrated. */
export async function createThrowawayDatabase(): Promise<ThrowawayDatabase> {
  const databaseName = `slopwatch_test_${process.pid}_${Date.now().toString(36)}_${databaseCounter++}`;

  const maintainer = new Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await maintainer.connect();
  await maintainer.query(`create database "${databaseName}"`);
  await maintainer.end();

  return {
    url: withDatabase(MAINTENANCE_DATABASE_URL, databaseName),

    async drop() {
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

/** A User the admin plane created, with the token it minted, shown once. */
export interface CreatedUser {
  id: string;
  name: string;
  email: string;
  token: string;
}

/**
 * A running Server backed by its own throwaway database. Tests drive it over
 * HTTP; nothing here reaches into the Server's internals.
 */
export interface TestServer {
  readonly url: string;
  readonly adminToken: string;
  /** Mint a User through the admin API, returning their bearer token. */
  createUser(name: string, email: string): Promise<CreatedUser>;
  /** Truncate every application table, giving each test a clean slate. */
  reset(): Promise<void>;
  /** Stop the Server and drop its database. */
  stop(): Promise<void>;
}

/** Add a User through a Server's admin plane, returning them with their token. */
export async function adminCreateUser(
  serverUrl: string,
  adminToken: string,
  name: string,
  email: string,
): Promise<CreatedUser> {
  const response = await fetch(`${serverUrl}/api/admin/users`, {
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
  return (await response.json()) as CreatedUser;
}

/** Ship a batch of Events for a bearer token, asserting the Server accepted. */
export async function shipEvents(
  serverUrl: string,
  token: string,
  events: unknown[],
): Promise<void> {
  const response = await fetch(`${serverUrl}/api/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  });
  if (response.status !== 202) {
    throw new Error(
      `could not ship Events: ${response.status} ${await response.text()}`,
    );
  }
}

/** Boot a real Server against a fresh, migrated Postgres database. */
export async function startTestServer(): Promise<TestServer> {
  const adminToken = `slop_admin_${randomUUID()}`;
  const database = await createThrowawayDatabase();
  const handle = await startServer({
    databaseUrl: database.url,
    adminToken,
    port: 0,
  });

  return {
    url: handle.url,
    adminToken,

    async createUser(name, email) {
      return adminCreateUser(handle.url, adminToken, name, email);
    },

    async reset() {
      const client = new Client({ connectionString: database.url });
      await client.connect();
      await client.query(
        "truncate users, tokens, sessions, turns, events, model_requests, " +
          "user_daily_rollup, user_hourly_rollup cascade",
      );
      await client.end();
    },

    async stop() {
      await handle.stop();
      await database.drop();
    },
  };
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
