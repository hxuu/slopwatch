import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import {
  modelRequest,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

interface SessionSummaryView {
  id: string;
  cwd: string | null;
  parentSessionId: string | null;
  turnCount: number;
  costUsd: number | null;
}

interface TurnView {
  id: string;
  prompt: string | null;
  response: string | null;
  costUsd: number | null;
}

interface SessionDetailView extends SessionSummaryView {
  spawnedByTurnId: string | null;
  turns: TurnView[];
  childSessions: SessionSummaryView[];
}

/**
 * A Subagent is a Session spawned by a Turn in another Session. These tests
 * drive it through the Server's HTTP API: synthetic Events in, the persisted
 * link and its views out.
 */
describeServer("Subagents as child Sessions", (server) => {
  let token: string;

  beforeEach(async () => {
    token = (await server().createUser("Alice", "alice@example.com")).token;
  });

  async function ship(events: unknown[]): Promise<Response> {
    return fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });
  }

  async function sessionDetail(sessionId: string): Promise<SessionDetailView> {
    return (await (
      await fetch(`${server().url}/api/sessions/${sessionId}`)
    ).json()) as SessionDetailView;
  }

  test("the parent Session's detail lists its child Sessions", async () => {
    const parentSessionId = randomUUID();
    const parentTurnId = randomUUID();
    const childSessionId = randomUUID();

    await ship([
      sessionStarted({ sessionId: parentSessionId }),
      turnStarted({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        prompt: "explore the repo",
      }),
      sessionStarted({
        sessionId: childSessionId,
        parentSessionId,
        spawnedByTurnId: parentTurnId,
      }),
    ]);

    const parent = await sessionDetail(parentSessionId);

    expect(parent.childSessions.map((child) => child.id)).toEqual([
      childSessionId,
    ]);
  });

  test("the parent Session page lists its Subagents and links to them", async () => {
    const parentSessionId = randomUUID();
    const parentTurnId = randomUUID();
    const childSessionId = randomUUID();

    await ship([
      sessionStarted({ sessionId: parentSessionId }),
      turnStarted({ sessionId: parentSessionId, turnId: parentTurnId }),
      sessionStarted({
        sessionId: childSessionId,
        parentSessionId,
        spawnedByTurnId: parentTurnId,
      }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${parentSessionId}`)
    ).text();

    expect(body).toContain(`/sessions/${childSessionId}`);
    expect(body).toContain(childSessionId);
  });

  test("a Subagent is readable on its own, with its own Turns and its own cost", async () => {
    const parentSessionId = randomUUID();
    const parentTurnId = randomUUID();
    const childSessionId = randomUUID();
    const childTurnId = randomUUID();

    await ship([
      sessionStarted({ sessionId: parentSessionId }),
      turnStarted({ sessionId: parentSessionId, turnId: parentTurnId }),
      sessionStarted({
        sessionId: childSessionId,
        parentSessionId,
        spawnedByTurnId: parentTurnId,
        cwd: "/home/dev/project/packages",
      }),
      turnStarted({
        sessionId: childSessionId,
        turnId: childTurnId,
        prompt: "find the schema",
      }),
      modelRequest({
        sessionId: childSessionId,
        turnId: childTurnId,
        costUsd: 0.04,
      }),
      turnEnded({
        sessionId: childSessionId,
        turnId: childTurnId,
        response: "It is in migrations.ts.",
      }),
    ]);

    const child = await sessionDetail(childSessionId);

    // The link back to the parent Session and the Turn that spawned it.
    expect(child.parentSessionId).toBe(parentSessionId);
    expect(child.spawnedByTurnId).toBe(parentTurnId);
    expect(child.cwd).toBe("/home/dev/project/packages");
    // Its own Turns and its own cost, independent of the parent.
    expect(child.turns.map((turn) => turn.id)).toEqual([childTurnId]);
    expect(child.turns[0].prompt).toBe("find the schema");
    expect(child.turns[0].response).toBe("It is in migrations.ts.");
    expect(child.costUsd).toBeCloseTo(0.04);
  });

  test("a Subagent's cost is not double-counted against its parent", async () => {
    const parentSessionId = randomUUID();
    const parentTurnId = randomUUID();
    const childSessionId = randomUUID();
    const childTurnId = randomUUID();

    await ship([
      sessionStarted({ sessionId: parentSessionId }),
      turnStarted({ sessionId: parentSessionId, turnId: parentTurnId }),
      modelRequest({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        costUsd: 0.01,
      }),
      sessionStarted({
        sessionId: childSessionId,
        parentSessionId,
        spawnedByTurnId: parentTurnId,
      }),
      turnStarted({ sessionId: childSessionId, turnId: childTurnId }),
      modelRequest({
        sessionId: childSessionId,
        turnId: childTurnId,
        costUsd: 0.04,
      }),
      turnEnded({ sessionId: childSessionId, turnId: childTurnId }),
    ]);

    // The parent reports only its own Model requests, not its Subagent's.
    const parent = await sessionDetail(parentSessionId);
    expect(parent.costUsd).toBeCloseTo(0.01);
    const child = await sessionDetail(childSessionId);
    expect(child.costUsd).toBeCloseTo(0.04);

    // Across the list, each Session is counted once: 0.01 + 0.04, not 0.09.
    const listed = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as SessionSummaryView[];
    const total = listed.reduce(
      (sum, session) => sum + (session.costUsd ?? 0),
      0,
    );
    expect(total).toBeCloseTo(0.05);
  });

  test("a Session with no Subagents lists none", async () => {
    const sessionId = randomUUID();
    await ship([sessionStarted({ sessionId })]);

    const detail = await sessionDetail(sessionId);

    expect(detail.childSessions).toEqual([]);
  });
});
