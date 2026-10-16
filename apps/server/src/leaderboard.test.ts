import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import type { CodingAgent } from "@slopwatch/events";
import { describeServer } from "./test/harness";
import {
  modelRequest,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

/** A fixed day every fixture lands on, so "today" is deterministic in tests. */
const DAY = "2026-10-15";

interface CreatedUser {
  id: string;
  name: string;
  email: string;
  token: string;
}

interface LeaderboardUser {
  user: { id: string; name: string; email: string };
  spendUsd: number | null;
  sessionCount: number;
  turnCount: number;
  requestCount: number;
  topAgent: string | null;
  delta7d: number | null;
  hourlySpend: (number | null)[];
}

/**
 * The leaderboard, rollups, and spend-by-agent surface, observed only through
 * the Server's HTTP API. Fixtures name explicit `occurredAt`s and the query
 * names an explicit day, so "today" never depends on the wall clock.
 */
describeServer("leaderboard, rollups, and spend by agent", (server) => {
  let alice: CreatedUser;
  let bob: CreatedUser;

  beforeEach(async () => {
    alice = await server().createUser("Alice", "alice@example.com");
    bob = await server().createUser("Bob", "bob@example.com");
  });

  async function ship(token: string, events: unknown[]): Promise<void> {
    const response = await fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });
    expect(response.status).toBe(202);
  }

  /** One Session with one Turn carrying one Model request of `costUsd`. */
  async function spend(
    token: string,
    costUsd: number | undefined,
    occurredAt: string,
    agent?: CodingAgent,
  ): Promise<void> {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship(token, [
      sessionStarted({ sessionId, occurredAt, ...(agent ? { agent } : {}) }),
      turnStarted({ sessionId, turnId, occurredAt }),
      modelRequest({
        sessionId,
        turnId,
        costUsd,
        occurredAt,
        ...(agent ? { agent } : {}),
      }),
      turnEnded({ sessionId, turnId, occurredAt }),
    ]);
  }

  async function leaderboard(date = DAY): Promise<LeaderboardUser[]> {
    const response = await fetch(
      `${server().url}/api/leaderboard?date=${date}`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { users: LeaderboardUser[] }).users;
  }

  test("ranks Users by today's spend, descending", async () => {
    await spend(alice.token, 0.02, `${DAY}T10:00:00.000Z`);
    await spend(bob.token, 0.05, `${DAY}T11:00:00.000Z`);

    const users = await leaderboard();

    expect(users.map((row) => row.user.name)).toEqual(["Bob", "Alice"]);
    expect(users[0].spendUsd).toBeCloseTo(0.05);
    expect(users[1].spendUsd).toBeCloseTo(0.02);
  });

  test("each row carries spend, Session, Turn, and Model request counts, and the top coding agent", async () => {
    const firstSession = randomUUID();
    const firstTurn = randomUUID();
    const secondSession = randomUUID();
    const secondTurn = randomUUID();
    await ship(alice.token, [
      sessionStarted({
        sessionId: firstSession,
        occurredAt: `${DAY}T10:00:00.000Z`,
      }),
      turnStarted({
        sessionId: firstSession,
        turnId: firstTurn,
        occurredAt: `${DAY}T10:00:00.000Z`,
      }),
      modelRequest({
        sessionId: firstSession,
        turnId: firstTurn,
        costUsd: 0.02,
        occurredAt: `${DAY}T10:00:00.000Z`,
        agent: "opencode",
      }),
      modelRequest({
        sessionId: firstSession,
        turnId: firstTurn,
        costUsd: 0.03,
        occurredAt: `${DAY}T10:01:00.000Z`,
        agent: "opencode",
      }),
      turnEnded({
        sessionId: firstSession,
        turnId: firstTurn,
        occurredAt: `${DAY}T10:02:00.000Z`,
      }),
      sessionStarted({
        sessionId: secondSession,
        occurredAt: `${DAY}T11:00:00.000Z`,
        agent: "claude-code",
      }),
      turnStarted({
        sessionId: secondSession,
        turnId: secondTurn,
        occurredAt: `${DAY}T11:00:00.000Z`,
        agent: "claude-code",
      }),
      modelRequest({
        sessionId: secondSession,
        turnId: secondTurn,
        costUsd: 0.01,
        occurredAt: `${DAY}T11:00:00.000Z`,
        agent: "claude-code",
      }),
      turnEnded({
        sessionId: secondSession,
        turnId: secondTurn,
        occurredAt: `${DAY}T11:01:00.000Z`,
        agent: "claude-code",
      }),
    ]);

    const [row] = await leaderboard();

    expect(row.spendUsd).toBeCloseTo(0.06);
    expect(row.sessionCount).toBe(2);
    expect(row.turnCount).toBe(2);
    expect(row.requestCount).toBe(3);
    expect(row.topAgent).toBe("opencode");
  });

  test("the 7-day delta compares this week's spend with the previous week's", async () => {
    await spend(alice.token, 0.1, "2026-10-08T10:00:00.000Z");
    await spend(alice.token, 0.15, `${DAY}T10:00:00.000Z`);

    const [row] = await leaderboard();

    // (0.15 - 0.10) / 0.10.
    expect(row.delta7d).toBeCloseTo(0.5);
  });

  test("a User with no previous week of spend has an unknown delta, not a free one", async () => {
    await spend(alice.token, 0.15, `${DAY}T10:00:00.000Z`);

    const [row] = await leaderboard();

    expect(row.delta7d).toBeNull();
  });

  test("each row carries a 24-point hourly spend sparkline", async () => {
    await spend(alice.token, 0.02, `${DAY}T10:30:00.000Z`);
    await spend(alice.token, 0.03, `${DAY}T10:45:00.000Z`);
    await spend(alice.token, 0.07, `${DAY}T14:00:00.000Z`);

    const [row] = await leaderboard();

    expect(row.hourlySpend).toHaveLength(24);
    expect(row.hourlySpend[10]).toBeCloseTo(0.05);
    expect(row.hourlySpend[14]).toBeCloseTo(0.07);
    // Every hour without spend is zero, not missing.
    expect(row.hourlySpend[0]).toBe(0);
    expect(row.hourlySpend[23]).toBe(0);
  });

  test("breaks org spend down per coding agent", async () => {
    await spend(alice.token, 0.02, `${DAY}T10:00:00.000Z`, "opencode");
    await spend(bob.token, 0.05, `${DAY}T11:00:00.000Z`, "opencode");
    await spend(alice.token, 0.03, `${DAY}T12:00:00.000Z`, "claude-code");

    const response = await fetch(
      `${server().url}/api/spend-by-agent?date=${DAY}`,
    );
    expect(response.status).toBe(200);
    const { agents } = (await response.json()) as { agents: unknown[] };

    expect(agents).toEqual([
      { agent: "opencode", spendUsd: 0.07, requestCount: 2 },
      { agent: "claude-code", spendUsd: 0.03, requestCount: 1 },
    ]);
  });

  test("the rollup spend agrees with the Model requests that produced it", async () => {
    await spend(alice.token, 0.02, `${DAY}T09:00:00.000Z`);
    await spend(alice.token, 0.03, `${DAY}T13:00:00.000Z`);
    await spend(alice.token, 0.05, `${DAY}T18:00:00.000Z`);

    const [row] = await leaderboard();
    const hourlyTotal = row.hourlySpend.reduce<number>(
      (total, point) => total + (point ?? 0),
      0,
    );

    expect(row.spendUsd).toBeCloseTo(0.1);
    expect(hourlyTotal).toBeCloseTo(row.spendUsd ?? 0);
    expect(row.requestCount).toBe(3);
  });

  test("a replayed Model request does not double-count in the rollups", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const requestId = randomUUID();
    const events = [
      sessionStarted({ sessionId, occurredAt: `${DAY}T10:00:00.000Z` }),
      turnStarted({ sessionId, turnId, occurredAt: `${DAY}T10:00:00.000Z` }),
      modelRequest({
        id: requestId,
        sessionId,
        turnId,
        costUsd: 0.04,
        occurredAt: `${DAY}T10:00:00.000Z`,
      }),
      turnEnded({ sessionId, turnId, occurredAt: `${DAY}T10:01:00.000Z` }),
    ];

    await ship(alice.token, events);
    await ship(alice.token, events);

    const [row] = await leaderboard();

    expect(row.spendUsd).toBeCloseTo(0.04);
    expect(row.requestCount).toBe(1);
  });

  test("a Model request that reported no cost leaves the spend unknown, not free", async () => {
    await spend(alice.token, undefined, `${DAY}T10:00:00.000Z`);

    const [row] = await leaderboard();

    expect(row.spendUsd).toBeNull();
    expect(row.hourlySpend[10]).toBeNull();
  });

  test("renders the leaderboard as a page ranked by today's spend", async () => {
    await spend(alice.token, 0.02, `${DAY}T10:00:00.000Z`);
    await spend(bob.token, 0.05, `${DAY}T11:00:00.000Z`);

    const response = await fetch(`${server().url}/leaderboard?date=${DAY}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Alice");
    expect(body).toContain("Bob");
    expect(body.indexOf("Bob")).toBeLessThan(body.indexOf("Alice"));
    // A leaderboard row links to that User's Sessions.
    expect(body).toContain(`/users/${alice.id}`);
  });

  test("renders the spend-by-agent breakdown as a page", async () => {
    await spend(alice.token, 0.02, `${DAY}T10:00:00.000Z`, "opencode");
    await spend(alice.token, 0.03, `${DAY}T11:00:00.000Z`, "claude-code");

    const response = await fetch(`${server().url}/spend-by-agent?date=${DAY}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("opencode");
    expect(body).toContain("claude-code");
  });
});
