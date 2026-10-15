import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import {
  sessionEnded,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

describeServer("reading a Session back", (server) => {
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

  test("a Session with Turns round-trips and is readable through the API", async () => {
    const sessionId = randomUUID();
    const firstTurn = randomUUID();
    const secondTurn = randomUUID();
    await ship([
      sessionStarted({ sessionId, cwd: "/home/dev/project" }),
      turnStarted({
        sessionId,
        turnId: firstTurn,
        prompt: "add a health check",
      }),
      turnEnded({
        sessionId,
        turnId: firstTurn,
        response: "Added GET /health.",
      }),
      turnStarted({
        sessionId,
        turnId: secondTurn,
        prompt: "add a test for it",
      }),
      turnEnded({
        sessionId,
        turnId: secondTurn,
        response: "Added a test that asserts 200.",
      }),
      sessionEnded({ sessionId }),
    ]);

    const list = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{
      id: string;
      cwd: string;
      endedAt: string | null;
      turnCount: number;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(sessionId);
    expect(list[0].cwd).toBe("/home/dev/project");
    expect(list[0].turnCount).toBe(2);
    expect(list[0].endedAt).not.toBeNull();

    const detail = (await (
      await fetch(`${server().url}/api/sessions/${sessionId}`)
    ).json()) as {
      id: string;
      turns: Array<{ id: string; prompt: string; response: string }>;
    };
    expect(detail.id).toBe(sessionId);
    expect(detail.turns.map((turn) => turn.id)).toEqual([
      firstTurn,
      secondTurn,
    ]);
    expect(detail.turns[0].prompt).toBe("add a health check");
    expect(detail.turns[0].response).toBe("Added GET /health.");
    expect(detail.turns[1].prompt).toBe("add a test for it");
  });

  test("since_seq returns exactly the increment, in order", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ]);

    const all = (await (
      await fetch(
        `${server().url}/api/sessions/${sessionId}/events?since_seq=0`,
      )
    ).json()) as { events: Array<{ seq: number; event: { kind: string } }> };
    expect(all.events.map((stored) => stored.seq)).toEqual([1, 2, 3]);
    expect(all.events.map((stored) => stored.event.kind)).toEqual([
      "session.started",
      "turn.started",
      "turn.ended",
    ]);

    const increment = (await (
      await fetch(
        `${server().url}/api/sessions/${sessionId}/events?since_seq=1`,
      )
    ).json()) as { events: Array<{ seq: number }> };
    expect(increment.events.map((stored) => stored.seq)).toEqual([2, 3]);
  });

  test("an unknown Session is a 404", async () => {
    const response = await fetch(`${server().url}/api/sessions/does-not-exist`);

    expect(response.status).toBe(404);
  });
});
