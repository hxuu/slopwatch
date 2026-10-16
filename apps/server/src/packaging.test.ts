import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sessionStarted } from "./test/events";
import {
  adminCreateUser,
  createThrowawayDatabase,
  postgresAvailable,
  shipEvents,
  type ThrowawayDatabase,
} from "./test/harness";

const SERVER_DIR = join(import.meta.dir, "..");
const SOURCE_DIR = import.meta.dir;
const BINARY = join(SERVER_DIR, "dist", "slopwatch");
const ADMIN_TOKEN = "slop_admin_packaging";

/**
 * The migration whose absence defines the older release below. The upgrade test
 * observes it through the leaderboard, which reads the tables it creates.
 */
const ROLLUP_MIGRATION_ID = "0003_rollups";

beforeAll(async () => {
  // The artifact an admin builds, produced by the package's own script. Every
  // test below runs it, so a broken build fails here.
  await bunBuild(["run", "build"]);
});

test("refuses to start without a Postgres URL", async () => {
  const binary = Bun.spawn([BINARY], {
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await binary.exited).not.toBe(0);
  expect(await new Response(binary.stderr).text()).toContain("DATABASE_URL");
});

describe.skipIf(!postgresAvailable)("the packaged binary", () => {
  let database: ThrowawayDatabase;
  let olderRelease: BuiltRelease;

  beforeAll(async () => {
    olderRelease = await buildOlderRelease();
  });

  afterAll(async () => {
    await olderRelease.cleanup();
  });

  beforeEach(async () => {
    database = await createThrowawayDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  test("runs the Server from a Postgres URL alone", async () => {
    const server = await runBinary(BINARY, { DATABASE_URL: database.url });
    try {
      const health = await fetch(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
    } finally {
      await server.stop();
    }
  });

  test("serves the dashboard and its assets, with no separate static deploy", async () => {
    const server = await runBinary(BINARY, binaryEnv(database.url));
    try {
      const dashboard = await fetch(`${server.url}/`);
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      const html = await dashboard.text();
      expect(html).toContain("<h1>Sessions</h1>");
      // The stylesheet and the live-view script are inlined into the page.
      expect(html).toContain("<style>");

      const user = await adminCreateUser(
        server.url,
        ADMIN_TOKEN,
        "Alice",
        "alice@example.com",
      );
      const sessionId = randomUUID();
      await shipEvents(server.url, user.token, [sessionStarted({ sessionId })]);
      const sessionPage = await (
        await fetch(`${server.url}/sessions/${sessionId}`)
      ).text();
      expect(sessionPage).toContain("<script>");
      expect(sessionPage).toContain("data-poll-ms");

      // The rollup migration ran, so the leaderboard reads rather than 500s.
      expect((await fetch(`${server.url}/api/leaderboard`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("applies a migration a newer binary adds, keeping the older binary's data", async () => {
    // An older release captures a User and a Session against its older schema.
    const older = await runBinary(olderRelease.binary, binaryEnv(database.url));
    let sessionId: string;
    try {
      const user = await adminCreateUser(
        older.url,
        ADMIN_TOKEN,
        "Alice",
        "alice@example.com",
      );
      sessionId = randomUUID();
      await shipEvents(older.url, user.token, [sessionStarted({ sessionId })]);
      // The rollup tables are absent, which a leaderboard read surfaces as a 500.
      expect((await fetch(`${older.url}/api/leaderboard`)).status).toBe(500);
    } finally {
      await older.stop();
    }

    // The newer binary, pointed at the same database, applies the pending
    // migration and serves the data the older release captured. Restarting it
    // proves the migrations stay applied rather than re-running.
    for (let boot = 0; boot < 2; boot += 1) {
      const server = await runBinary(BINARY, binaryEnv(database.url));
      try {
        expect((await fetch(`${server.url}/api/leaderboard`)).status).toBe(200);
        const sessions = (await (
          await fetch(`${server.url}/api/sessions`)
        ).json()) as { id: string }[];
        expect(sessions.map((session) => session.id)).toContain(sessionId);
      } finally {
        await server.stop();
      }
    }
  });
});

/** The environment a deployed binary gets: a Postgres URL and its options. */
function binaryEnv(databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    SLOPWATCH_ADMIN_TOKEN: ADMIN_TOKEN,
    PORT: "0",
  };
}

/** Run a `bun build`-family command in the package, failing loudly on error. */
async function bunBuild(args: string[]): Promise<void> {
  const build = Bun.spawn(["bun", ...args], {
    cwd: SERVER_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(
      `\`bun ${args.join(" ")}\` failed (${exitCode}):\n${await new Response(build.stderr).text()}`,
    );
  }
}

interface BuiltRelease {
  /** The compiled executable to run. */
  readonly binary: string;
  /** Remove the throwaway source tree the release was compiled from. */
  cleanup(): Promise<void>;
}

/**
 * Compile a stand-in for an older release: the Server as it existed before the
 * rollup migration. It is built from a throwaway copy of the source whose
 * `./migrations` stops short, so the upgrade test drives two real binaries over
 * HTTP rather than reaching into the Server's modules.
 */
async function buildOlderRelease(): Promise<BuiltRelease> {
  // The copy lives inside the package so Node resolution still finds its
  // dependencies, but out of `src` so tooling never sees it.
  const directory = await mkdtemp(join(SERVER_DIR, ".older-release-"));
  try {
    await cp(SOURCE_DIR, join(directory, "src"), {
      recursive: true,
      filter: (path) => !path.endsWith(".test.ts"),
    });

    // Redirect the copied source's `./migrations` at every migration before the
    // rollup one, imported from the real module.
    const current = relative(
      join(directory, "src"),
      join(SOURCE_DIR, "migrations"),
    );
    await writeFile(
      join(directory, "src", "migrations.ts"),
      olderMigrationsModule(current),
    );

    const binary = join(directory, "slopwatch");
    await bunBuild([
      "build",
      "--compile",
      `--outfile=${binary}`,
      join(directory, "src", "index.ts"),
    ]);
    return { binary, cleanup: () => rm(directory, { recursive: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The generated `migrations.ts` a stand-in older release compiles against. */
function olderMigrationsModule(currentMigrations: string): string {
  return `import { migrations as all, type Migration } from ${JSON.stringify(currentMigrations)};

// Every migration up to, but not including, the rollups: the schema as the
// previous release knew it.
const cutoff = all.findIndex(
  (migration) => migration.id === ${JSON.stringify(ROLLUP_MIGRATION_ID)},
);
if (cutoff < 0) {
  throw new Error("cannot build an older release: the rollup migration is gone");
}
export const migrations: Migration[] = all.slice(0, cutoff);
export type { Migration };
`;
}

interface RunningBinary {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Start a compiled binary with the given environment, and read the URL it
 * announces on stdout. `PORT=0` binds an ephemeral port so tests never clash;
 * without it the binary uses its default port.
 */
async function runBinary(
  binaryPath: string,
  env: Record<string, string>,
): Promise<RunningBinary> {
  const binary = Bun.spawn([binaryPath], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(binary.stderr).text();

  try {
    const url = await withTimeout(
      readListeningUrl(binary.stdout),
      15_000,
      "the binary never reported a listening URL",
    );
    return {
      url,
      async stop() {
        binary.kill();
        await binary.exited;
      },
    };
  } catch (error) {
    binary.kill();
    throw new Error(`${String(error)}\n${await stderr}`, { cause: error });
  }
}

/** Read the binary's stdout until it announces the URL it is listening on. */
async function readListeningUrl(
  stdout: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    const match = /listening on (\S+)/.exec(output);
    if (match) return match[1];
  }
  throw new Error(`the binary exited before listening:\n${output}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
