import { beforeEach, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode/client";
import { describeServer } from "@slopwatch/server/test/harness";
import { type ListenerContext, setupListener, startListener } from "./plugin";
import { PROMPT, RESPONSE, SESSION_ID, recordedSession } from "./test/fixtures";

/**
 * A fake of the slice of OpenCode's plugin context the Listener uses: enough to
 * replay recorded events as if OpenCode had dispatched them.
 */
function context(
  events: OpenCodeEvent[],
  options: Record<string, unknown> = {},
): ListenerContext {
  return {
    app: { version: "2.0.26" },
    location: { directory: "/home/dev/project" },
    options,
    event: { subscribe: () => stream(events) },
  };
}

async function* stream(events: OpenCodeEvent[]): AsyncIterable<OpenCodeEvent> {
  for (const event of events) yield event;
}

describeServer("the OpenCode plugin's event subscription", (server) => {
  let token: string;

  beforeEach(async () => {
    token = (await server().createUser("Alice", "alice@example.com")).token;
  });

  test("replays the event stream into a Session on the Server", async () => {
    const reported: string[] = [];
    const running = await setupListener(
      context(recordedSession),
      { url: server().url, token, flushIntervalMs: 0 },
      { report: (message) => reported.push(message) },
    );

    expect(running).not.toBeNull();
    await running?.idle;
    await running?.stop();

    expect(reported).toEqual([]);

    const detail = (await (
      await fetch(`${server().url}/api/sessions/${SESSION_ID}`)
    ).json()) as { turns: Array<{ prompt: string; response: string }> };
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].prompt).toBe(PROMPT);
    expect(detail.turns[0].response).toBe(RESPONSE);
  });

  test("stays inactive and reports when no token is configured", async () => {
    const reported: string[] = [];
    const running = await setupListener(
      context(recordedSession),
      { url: server().url },
      {
        report: (message) => reported.push(message),
        readToken: async () => null,
      },
    );

    expect(running).toBeNull();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("token");

    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as unknown[];
    expect(sessions).toEqual([]);
  });

  test("startListener starts off the load path and reports, never throws", async () => {
    const reported: string[] = [];
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });

    const handle = startListener(context(recordedSession), {
      report: (message) => reported.push(message),
      readToken: async () => {
        await tokenGate;
        return null;
      },
    });

    // The call returned while the token read was still pending: nothing on
    // OpenCode's load path waits for startup.
    expect(typeof handle.stop).toBe("function");

    releaseToken();
    await handle.started;

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("token");
    await handle.stop();
  });
});
