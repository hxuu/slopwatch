import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import {
  modelRequest,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

interface ModelRequestView {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

interface TurnView {
  id: string;
  costUsd: number | null;
  modelRequests: ModelRequestView[];
}

interface SessionDetailView {
  costUsd: number | null;
  turns: TurnView[];
}

describeServer("Model requests and cost", (server) => {
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

  test("a Turn containing several Model requests persists each one separately", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      modelRequest({
        sessionId,
        turnId,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_200,
        outputTokens: 80,
        latencyMs: 2_100,
      }),
      modelRequest({
        sessionId,
        turnId,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 300,
        outputTokens: 40,
        latencyMs: 900,
      }),
      turnEnded({ sessionId, turnId }),
    ]);

    const turn = (await sessionDetail(sessionId)).turns[0];

    expect(turn.id).toBe(turnId);
    expect(turn.modelRequests).toHaveLength(2);
    expect(turn.modelRequests[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1_200,
      outputTokens: 80,
      latencyMs: 2_100,
    });
    expect(turn.modelRequests[1]).toMatchObject({
      inputTokens: 300,
      outputTokens: 40,
      latencyMs: 900,
    });
  });

  test("cost is reported per Turn and per Session, summing the Model requests", async () => {
    const sessionId = randomUUID();
    const firstTurn = randomUUID();
    const secondTurn = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId: firstTurn }),
      modelRequest({ sessionId, turnId: firstTurn, costUsd: 0.02 }),
      modelRequest({ sessionId, turnId: firstTurn, costUsd: 0.03 }),
      turnEnded({ sessionId, turnId: firstTurn }),
      turnStarted({ sessionId, turnId: secondTurn }),
      modelRequest({ sessionId, turnId: secondTurn, costUsd: 0.05 }),
      turnEnded({ sessionId, turnId: secondTurn }),
    ]);

    const detail = await sessionDetail(sessionId);

    expect(detail.turns[0].costUsd).toBeCloseTo(0.05);
    expect(detail.turns[1].costUsd).toBeCloseTo(0.05);
    // The Session's cost is the sum of its Model requests, no more, no less.
    expect(detail.costUsd).toBeCloseTo(0.1);
    const summed = detail.turns
      .flatMap((turn) => turn.modelRequests)
      .reduce((total, request) => total + (request.costUsd ?? 0), 0);
    expect(detail.costUsd).toBeCloseTo(summed);

    const [listed] = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{ id: string; costUsd: number | null }>;
    expect(listed.id).toBe(sessionId);
    expect(listed.costUsd).toBeCloseTo(0.1);
  });

  test("rejects a Model request that does not match the schema", async () => {
    const sessionId = randomUUID();
    const malformed = {
      ...modelRequest({ sessionId, turnId: randomUUID() }),
      inputTokens: "many",
    };

    const response = await ship([sessionStarted({ sessionId }), malformed]);

    expect(response.status).toBe(400);
  });

  test("a Turn with no Model requests reports no cost", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ]);

    const detail = await sessionDetail(sessionId);

    expect(detail.turns[0].modelRequests).toEqual([]);
    expect(detail.turns[0].costUsd).toBeNull();
    expect(detail.costUsd).toBeNull();
  });

  test("a Model request that reported no cost is unknown, not free", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      modelRequest({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ]);

    const detail = await sessionDetail(sessionId);

    expect(detail.turns[0].modelRequests).toHaveLength(1);
    expect(detail.turns[0].modelRequests[0].costUsd).toBeNull();
    expect(detail.turns[0].costUsd).toBeNull();
    expect(detail.costUsd).toBeNull();
  });
});
