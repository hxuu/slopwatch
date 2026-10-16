import type { NormalEvent } from "@slopwatch/events";
import type { Pool } from "pg";
import { tokensMatch } from "./auth";
import {
  renderLeaderboard,
  renderSessionDetail,
  renderSessionList,
  renderSpendByAgent,
} from "./dashboard";
import * as db from "./db";
import { createPool, migrate } from "./db";
import { leaderboard, spendByAgent, utcToday } from "./rollups";
import { isNormalEvent } from "./validate";

export interface ServerOptions {
  /** The Postgres URL the Server reads and writes. */
  databaseUrl: string;
  /** Bearer token the admin API requires. Admin endpoints are off without it. */
  adminToken?: string;
  /** TCP port; 0 binds an ephemeral port (tests). Defaults to 3000. */
  port?: number;
}

export interface ServerHandle {
  /** The origin the Server is listening on, e.g. `http://localhost:3000`. */
  readonly url: string;
  /** Stop accepting requests and close the pool. */
  stop(): Promise<void>;
}

/** Boot the Server: apply migrations, then serve HTTP. */
export async function startServer(
  options: ServerOptions,
): Promise<ServerHandle> {
  const pool = createPool(options.databaseUrl);

  let server: ReturnType<typeof Bun.serve>;
  try {
    await migrate(pool);
    server = Bun.serve({
      port: options.port ?? 3000,
      fetch: (request) => route(request, pool, options.adminToken),
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    url: `http://localhost:${server.port}`,
    async stop() {
      await server.stop(true);
      await pool.end();
    },
  };
}

async function route(
  request: Request,
  pool: Pool,
  adminToken: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      return await health(pool);
    }

    if (request.method === "POST" && pathname === "/api/admin/users") {
      return await addUser(request, pool, adminToken);
    }

    if (request.method === "GET" && pathname === "/api/admin/users") {
      return await listUsers(request, pool, adminToken);
    }

    const revokeMatch = /^\/api\/admin\/users\/([^/]+)\/revoke$/.exec(pathname);
    if (request.method === "POST" && revokeMatch) {
      return await revokeUserToken(
        request,
        pool,
        adminToken,
        decodeURIComponent(revokeMatch[1]),
      );
    }

    if (request.method === "POST" && pathname === "/api/events") {
      return await ingest(request, pool);
    }

    if (request.method === "GET" && pathname === "/api/sessions") {
      return Response.json(await db.listSessions(pool));
    }

    if (request.method === "GET" && pathname === "/api/leaderboard") {
      return await readLeaderboard(pool, url);
    }

    if (request.method === "GET" && pathname === "/api/spend-by-agent") {
      return await readSpendByAgent(pool, url);
    }

    const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(pathname);
    if (request.method === "GET" && eventsMatch) {
      return await readEvents(pool, decodeURIComponent(eventsMatch[1]), url);
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && sessionMatch) {
      return await readSession(pool, decodeURIComponent(sessionMatch[1]));
    }

    if (request.method === "GET" && pathname === "/") {
      return html(renderSessionList(await db.listSessions(pool)));
    }

    if (request.method === "GET" && pathname === "/leaderboard") {
      const day = dayParam(url);
      if (day instanceof Response) return day;
      return html(renderLeaderboard(await leaderboard(pool, day), day));
    }

    if (request.method === "GET" && pathname === "/spend-by-agent") {
      const day = dayParam(url);
      if (day instanceof Response) return day;
      return html(renderSpendByAgent(await spendByAgent(pool, day), day));
    }

    const sessionPageMatch = /^\/sessions\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && sessionPageMatch) {
      const session = await db.getSession(
        pool,
        decodeURIComponent(sessionPageMatch[1]),
      );
      if (!session) return notFound("session not found");
      return html(renderSessionDetail(session));
    }
  } catch (error) {
    console.error("[server] unhandled request error", error);
    return new Response("internal server error", { status: 500 });
  }

  return new Response("not found", { status: 404 });
}

/** `POST /api/admin/users`: add a User and mint their token, shown once. */
async function addUser(
  request: Request,
  pool: Pool,
  adminToken: string | undefined,
): Promise<Response> {
  const denied = requireAdmin(request, adminToken);
  if (denied) return denied;

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };
  if (!isNonBlankString(name) || !isNonBlankString(email)) {
    return badRequest("`name` and `email` are required");
  }

  try {
    const user = await db.createUser(pool, name, email);
    const token = await db.issueToken(pool, user.id);
    return Response.json({ ...user, token }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return new Response("a User with that email already exists", {
        status: 409,
      });
    }
    throw error;
  }
}

/** `GET /api/admin/users`: list every User with their identity fields. */
async function listUsers(
  request: Request,
  pool: Pool,
  adminToken: string | undefined,
): Promise<Response> {
  const denied = requireAdmin(request, adminToken);
  if (denied) return denied;

  return Response.json(await db.listUsers(pool));
}

/**
 * `POST /api/admin/users/:id/revoke`: revoke a User's token, taking effect on
 * their next ingestion attempt.
 */
async function revokeUserToken(
  request: Request,
  pool: Pool,
  adminToken: string | undefined,
  userId: string,
): Promise<Response> {
  const denied = requireAdmin(request, adminToken);
  if (denied) return denied;

  // A malformed User id names no User, so it is a 404 rather than a 500 from
  // Postgres rejecting the value as a uuid.
  if (!isUuid(userId) || !(await db.userExists(pool, userId))) {
    return notFound("User not found");
  }

  await db.revokeUserTokens(pool, userId);
  return new Response(null, { status: 204 });
}

/**
 * Guard an admin request. Admin is off without a configured token, and every
 * admin call must present it. Returns the response to send back, or null when
 * the caller may proceed.
 */
function requireAdmin(
  request: Request,
  adminToken: string | undefined,
): Response | null {
  if (!adminToken) {
    return new Response("admin API is disabled: set SLOPWATCH_ADMIN_TOKEN", {
      status: 503,
    });
  }
  const presented = bearerToken(request);
  if (!presented || !tokensMatch(presented, adminToken)) return unauthorized();
  return null;
}

/**
 * `POST /api/events`: persist a batch of Events for the token's User. The User
 * comes from the token, never from the request body.
 */
async function ingest(request: Request, pool: Pool): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized();
  const user = await db.findUserByToken(pool, token);
  if (!user) return unauthorized();

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return badRequest("`events` must be an array");
  for (const event of events) {
    if (!isNormalEvent(event)) {
      return badRequest("one or more Events do not match the schema");
    }
  }

  try {
    const accepted = await db.storeBatch(
      pool,
      user.id,
      events as NormalEvent[],
    );
    return Response.json({ accepted }, { status: 202 });
  } catch (error) {
    if (error instanceof db.SessionOwnershipError) {
      return new Response(error.message, { status: 403 });
    }
    throw error;
  }
}

/** `GET /api/sessions/:id/events?since_seq=N`: the incremental-poll contract. */
async function readEvents(
  pool: Pool,
  sessionId: string,
  url: URL,
): Promise<Response> {
  const sinceSeq = Number(url.searchParams.get("since_seq") ?? "0");
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    return badRequest("`since_seq` must be a non-negative integer");
  }
  if (!(await db.sessionExists(pool, sessionId))) {
    return notFound("session not found");
  }
  return Response.json({
    events: await db.listEventsSince(pool, sessionId, sinceSeq),
  });
}

/** `GET /api/sessions/:id`: one Session with its Turns. */
async function readSession(pool: Pool, sessionId: string): Promise<Response> {
  const session = await db.getSession(pool, sessionId);
  if (!session) return notFound("session not found");
  return Response.json(session);
}

/** `GET /api/leaderboard?date=YYYY-MM-DD`: Users ranked by the day's spend. */
async function readLeaderboard(pool: Pool, url: URL): Promise<Response> {
  const day = dayParam(url);
  if (day instanceof Response) return day;
  return Response.json({ date: day, users: await leaderboard(pool, day) });
}

/** `GET /api/spend-by-agent?date=YYYY-MM-DD`: org spend per coding agent. */
async function readSpendByAgent(pool: Pool, url: URL): Promise<Response> {
  const day = dayParam(url);
  if (day instanceof Response) return day;
  return Response.json({ date: day, agents: await spendByAgent(pool, day) });
}

/**
 * The day a windowed read is scoped to: the caller's `date`, or today in UTC.
 * A malformed date is a 400 rather than a silent fallback to today.
 */
function dayParam(url: URL): string | Response {
  const raw = url.searchParams.get("date");
  if (raw === null) return utcToday();
  if (!ISO_DAY_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    return badRequest("`date` must be an ISO date, e.g. 2026-10-15");
  }
  return raw;
}

/** `GET /api/health`: liveness, and a real round-trip to Postgres. */
async function health(pool: Pool): Promise<Response> {
  try {
    await pool.query("select 1");
    return Response.json({ status: "ok" });
  } catch (error) {
    console.error("[server] health check failed", error);
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Parse a JSON body, or return the 400 response to send back. */
async function readJson(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return badRequest("expected a JSON body");
  }
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function notFound(message: string): Response {
  return new Response(message, { status: 404 });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
