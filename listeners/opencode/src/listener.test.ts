import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "@slopwatch/server/test/harness";
import { createListener } from "./listener";
import {
  DELEGATING_SESSION_ID,
  DRIFTED_EVENT_TYPE,
  PROMPT,
  RESPONSE,
  SESSION_ID,
  SPAWN_TURN_ID,
  SUBAGENT_SESSION_ID,
  delegatingSession,
  driftedEvent,
  driftedSession,
  recordedSession,
  subagentSession,
} from "./test/fixtures";

/** The Events one recorded Session normalizes to, in dispatch order. */
const RECORDED_KINDS = [
  "session.started",
  "turn.started",
  "tool.call",
  "tool.result",
  "message",
  "model.request",
  "turn.ended",
  "session.ended",
];

/**
 * A `fetch` that fails until `online()` is called, standing in for a Server
 * outage. Cast because Bun's `fetch` type carries a static `preconnect`.
 */
function offlineFetch(): { fetch: typeof fetch; online: () => void } {
  let reachable = false;
  const impl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    reachable
      ? fetch(input, init)
      : Promise.reject(new Error("the Server is unreachable"))) as typeof fetch;
  return {
    fetch: impl,
    online: () => {
      reachable = true;
    },
  };
}

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

  /** The Sessions the Server currently knows about. */
  async function listedSessions(): Promise<Array<{ id: string }>> {
    return (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{ id: string }>;
  }

  /** The kinds of a Session's Events, in the order the Server stored them. */
  async function storedKinds(sessionId: string): Promise<string[]> {
    const body = (await (
      await fetch(
        `${server().url}/api/sessions/${sessionId}/events?since_seq=0`,
      )
    ).json()) as { events: Array<{ event: { kind: string } }> };
    return body.events.map((entry) => entry.event.kind);
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
          costUsd?: number;
        };
      }>;
    };
    expect(stored.events.map((entry) => entry.event.kind)).toEqual(
      RECORDED_KINDS,
    );

    const modelRequest = stored.events.find(
      (entry) => entry.event.kind === "model.request",
    )?.event;
    expect(modelRequest?.provider).toBe("anthropic");
    expect(modelRequest?.model).toBe("claude-sonnet-4-5");
    expect(modelRequest?.inputTokens).toBe(1_200);
    expect(modelRequest?.outputTokens).toBe(80);
    expect(modelRequest?.costUsd).toBe(0.02);
  });

  test("a real Session then appears in the dashboard", async () => {
    const capture = listener(() => {});
    for (const event of recordedSession) capture.handleEvent(event);
    await capture.stop();

    const body = await (await fetch(`${server().url}/`)).text();

    expect(body).toContain(SESSION_ID);
    expect(body).toContain("Alice");
  });

  test("a Subagent is captured as a child Session linked to its spawning Turn", async () => {
    const capture = listener(() => {});
    for (const event of delegatingSession) capture.handleEvent(event);
    for (const event of subagentSession) capture.handleEvent(event);
    await capture.stop();

    const child = (await (
      await fetch(`${server().url}/api/sessions/${SUBAGENT_SESSION_ID}`)
    ).json()) as {
      parentSessionId: string | null;
      spawnedByTurnId: string | null;
    };
    expect(child.parentSessionId).toBe(DELEGATING_SESSION_ID);
    expect(child.spawnedByTurnId).toBe(SPAWN_TURN_ID);

    const parent = (await (
      await fetch(`${server().url}/api/sessions/${DELEGATING_SESSION_ID}`)
    ).json()) as { childSessions: Array<{ id: string }> };
    expect(parent.childSessions.map((session) => session.id)).toEqual([
      SUBAGENT_SESSION_ID,
    ]);
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

  test("an unrecognized session event is reported loudly, not swallowed", async () => {
    const reported: string[] = [];
    const capture = listener((message) => reported.push(message));

    for (const event of driftedSession) capture.handleEvent(event);
    await capture.stop();

    // The renamed Turn-closing Event is the drift: it is reported, not swallowed.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(DRIFTED_EVENT_TYPE);

    // The Turn's Events still reached the Server, so what is missing is the
    // reported Turn-closing Event, not an invisible gap in the Session.
    const stored = (await (
      await fetch(
        `${server().url}/api/sessions/${SESSION_ID}/events?since_seq=0`,
      )
    ).json()) as { events: Array<{ event: { kind: string } }> };
    const kinds = stored.events.map((entry) => entry.event.kind);
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("session.ended");
    expect(kinds).not.toContain("turn.ended");
  });

  test("a batch the Server rejects is reported and dropped, not retried forever", async () => {
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
    expect(String(reported[0])).toContain("rejected");
    expect(await listedSessions()).toEqual([]);
  });

  test("Events spooled while the Server is unreachable drain on reconnect, in order", async () => {
    const reported: string[] = [];
    const outage = offlineFetch();
    const capture = createListener({
      baseUrl: server().url,
      token,
      flushIntervalMs: 0,
      fetch: outage.fetch,
      report: (message) => reported.push(message),
    });

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.flush();

    // Unreachable: nothing reached the Server, and the failure is reported.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("failed to ship");
    expect(await listedSessions()).toEqual([]);

    // Reconnect: the spool drains, and the Events land in their original order.
    outage.online();
    await capture.flush();
    await capture.stop();

    expect(await storedKinds(SESSION_ID)).toEqual(RECORDED_KINDS);
  });

  test("the spool drains itself on reconnect, with no further event", async () => {
    const outage = offlineFetch();
    const capture = createListener({
      baseUrl: server().url,
      token,
      flushIntervalMs: 10,
      fetch: outage.fetch,
      report: () => {},
    });

    for (const event of recordedSession) capture.handleEvent(event);
    // One failed attempt; the Listener has now scheduled a retry.
    await capture.flush();
    expect(await listedSessions()).toEqual([]);

    // Reconnect: the retry timer drains the spool on its own.
    outage.online();
    const deadline = Date.now() + 2_000;
    while ((await listedSessions()).length === 0 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    await capture.stop();

    expect(await storedKinds(SESSION_ID)).toEqual(RECORDED_KINDS);
  });

  test("a sustained outage is reported once, not on every retry", async () => {
    const reported: string[] = [];
    const capture = createListener({
      baseUrl: server().url,
      token,
      flushIntervalMs: 0,
      fetch: offlineFetch().fetch,
      report: (message) => reported.push(message),
    });

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.flush();
    await capture.flush();
    await capture.flush();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("failed to ship");
  });

  test("a Session captured entirely during an outage appears once the Server returns", async () => {
    const outage = offlineFetch();
    const capture = createListener({
      baseUrl: server().url,
      token,
      agentVersion: "2.0.26",
      directory: "/home/dev/project",
      flushIntervalMs: 0,
      fetch: outage.fetch,
      report: () => {},
    });

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.flush();
    expect(await listedSessions()).toEqual([]);

    outage.online();
    await capture.stop();

    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{
      id: string;
      cwd: string;
      endedAt: string | null;
      turnCount: number;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(SESSION_ID);
    expect(sessions[0].cwd).toBe("/home/dev/project");
    expect(sessions[0].endedAt).not.toBeNull();
    expect(sessions[0].turnCount).toBe(1);

    const detail = (await (
      await fetch(`${server().url}/api/sessions/${SESSION_ID}`)
    ).json()) as { turns: Array<{ prompt: string; response: string }> };
    expect(detail.turns[0].prompt).toBe(PROMPT);
    expect(detail.turns[0].response).toBe(RESPONSE);
  });

  test("the spool warns loudly at its cap and never truncates silently", async () => {
    const reported: string[] = [];
    const outage = offlineFetch();
    const capture = createListener({
      baseUrl: server().url,
      token,
      flushIntervalMs: 0,
      spoolCap: 3,
      fetch: outage.fetch,
      report: (message) => reported.push(message),
    });

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.flush();

    // The cap is announced, and the count of dropped Events is not hidden.
    const warnings = reported.filter((message) =>
      message.includes("offline spool is full"),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.at(-1)).toContain("5 dropped in total");

    // Only the newest Events survive; the rest were reported, not lost quietly.
    outage.online();
    await capture.flush();
    expect(await listedSessions()).toHaveLength(1);
    expect(await storedKinds(SESSION_ID)).toEqual(RECORDED_KINDS.slice(-3));
  });

  test("stop reports Events it could not ship rather than hanging or dropping them silently", async () => {
    const reported: string[] = [];
    const capture = createListener({
      baseUrl: server().url,
      token,
      flushIntervalMs: 0,
      fetch: offlineFetch().fetch,
      report: (message) => reported.push(message),
    });

    for (const event of recordedSession) capture.handleEvent(event);
    await capture.stop();

    expect(reported.some((message) => message.includes("offline spool"))).toBe(
      true,
    );
    expect(await listedSessions()).toEqual([]);
  });
});
