import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "@slopwatch/server/test/harness";
import { createListener } from "./listener";
import {
  PROMPT,
  RESPONSE,
  SESSION_ID,
  driftedEvent,
  recordedSession,
} from "./test/fixtures";

/**
 * Capture end to end through the one seam: recorded OpenCode plugin events go
 * into the Listener, and everything is observed through the Server's HTTP API.
 */
describeServer("capturing a Session with the OpenCode Listener", (server) => {
  let token: string;

  beforeEach(async () => {
    token = (await server().createUser("Alice", "alice@example.com")).token;
  });

  function listener(report: (message: string, details?: unknown) => void) {
    return createListener({
      baseUrl: server().url,
      token,
      agentVersion: "2.0.26",
      directory: "/home/dev/project",
      flushIntervalMs: 0,
      report,
    });
  }

  test("a recorded Session lands in the Server as a Session with a Turn and its Events", async () => {
    const reported: string[] = [];
    const capture = listener((message) => reported.push(message));

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.stop();

    expect(reported).toEqual([]);

    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{
      id: string;
      cwd: string;
      user: { email: string };
      turnCount: number;
      endedAt: string | null;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(SESSION_ID);
    expect(sessions[0].cwd).toBe("/home/dev/project");
    expect(sessions[0].user.email).toBe("alice@example.com");
    expect(sessions[0].turnCount).toBe(1);
    expect(sessions[0].endedAt).not.toBeNull();

    const detail = (await (
      await fetch(`${server().url}/api/sessions/${SESSION_ID}`)
    ).json()) as {
      turns: Array<{ id: string; prompt: string; response: string }>;
    };
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].id).toBe("msg_assistant_1");
    expect(detail.turns[0].prompt).toBe(PROMPT);
    expect(detail.turns[0].response).toBe(RESPONSE);

    const stored = (await (
      await fetch(
        `${server().url}/api/sessions/${SESSION_ID}/events?since_seq=0`,
      )
    ).json()) as {
      events: Array<{
        seq: number;
        event: {
          kind: string;
          provider?: string;
          model?: string;
          inputTokens?: number;
          outputTokens?: number;
        };
      }>;
    };
    expect(stored.events.map((entry) => entry.event.kind)).toEqual([
      "session.started",
      "turn.started",
      "tool.call",
      "tool.result",
      "message",
      "model.request",
      "turn.ended",
      "session.ended",
    ]);

    const modelRequest = stored.events.find(
      (entry) => entry.event.kind === "model.request",
    )?.event;
    expect(modelRequest?.provider).toBe("anthropic");
    expect(modelRequest?.model).toBe("claude-sonnet-4-5");
    expect(modelRequest?.inputTokens).toBe(1_200);
    expect(modelRequest?.outputTokens).toBe(80);
  });

  test("a real Session then appears in the dashboard", async () => {
    const capture = listener(() => {});
    for (const event of recordedSession) capture.handleEvent(event);
    await capture.stop();

    const body = await (await fetch(`${server().url}/`)).text();

    expect(body).toContain(SESSION_ID);
    expect(body).toContain("Alice");
  });

  test("an unrecognized event shape is reported loudly, not shipped", async () => {
    const reported: string[] = [];
    const capture = listener((message) => reported.push(message));

    capture.handleEvent(driftedEvent);
    await capture.stop();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("session id");
    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as unknown[];
    expect(sessions).toEqual([]);
  });

  test("a failing Server is reported rather than thrown at the caller", async () => {
    const reported: unknown[] = [];
    const capture = createListener({
      baseUrl: server().url,
      token: "not-a-real-token",
      batchSize: 1,
      report: (message, details) => reported.push([message, details]),
    });

    capture.handleEvent(recordedSession[0]);
    await capture.stop();

    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("failed to ship");

    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as unknown[];
    expect(sessions).toEqual([]);
  });
});
