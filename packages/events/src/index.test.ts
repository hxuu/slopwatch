import { describe, expect, test } from "bun:test";
import {
  type NormalEvent,
  type SessionStartedEvent,
  ShipEventsError,
  sendEvents,
} from "./index";

const sessionStarted: SessionStartedEvent = {
  kind: "session.started",
  id: "evt-1",
  sessionId: "ses-1",
  agent: "opencode",
  agentVersion: "1.2.3",
  occurredAt: "2026-10-15T10:00:00.000Z",
  cwd: "/home/dev/project",
  raw: { type: "session.created" },
};

/** Records the request a fake `fetch` was handed, and replies with a canned one. */
function recordingFetch(reply: Response): {
  fetch: typeof fetch;
  calls: Array<{ url: RequestInfo | URL; init: RequestInit | undefined }>;
} {
  const calls: Array<{
    url: RequestInfo | URL;
    init: RequestInit | undefined;
  }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url, init });
    return reply;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("sendEvents", () => {
  test("POSTs the batch to the Server's ingestion endpoint with the token", async () => {
    const { fetch, calls } = recordingFetch(
      Response.json({ accepted: 1 }, { status: 202 }),
    );

    const result = await sendEvents({
      baseUrl: "http://slopwatch.internal:3000",
      token: "slop_test",
      events: [sessionStarted],
      fetch,
    });

    expect(result).toEqual({ accepted: 1 });
    expect(calls).toHaveLength(1);
    expect(String(calls[0].url)).toBe(
      "http://slopwatch.internal:3000/api/events",
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body)) as {
      events: NormalEvent[];
    };
    expect(body.events).toEqual([sessionStarted]);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer slop_test");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("surfaces a rejected batch as a typed error", async () => {
    const { fetch } = recordingFetch(
      new Response("unauthorized", { status: 401 }),
    );

    const error = await sendEvents({
      baseUrl: "http://slopwatch.internal:3000",
      token: "bad",
      events: [sessionStarted],
      fetch,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ShipEventsError);
    expect((error as ShipEventsError).status).toBe(401);
    expect((error as ShipEventsError).message).toContain("unauthorized");
  });
});
