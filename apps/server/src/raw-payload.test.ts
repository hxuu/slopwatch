import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import { describeServer } from "./test/harness";
import {
  modelRequest,
  sessionEnded,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

/**
 * Raw-payload retention, observed through the one seam: an Event is shipped with
 * an original agent payload, and that exact payload is read back. Every Event
 * also records the coding agent and version that produced it.
 */
describeServer("raw payload retention", (server) => {
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

  interface StoredEvent {
    seq: number;
    raw: unknown;
    event: NormalEvent;
  }

  async function readEvents(sessionId: string): Promise<StoredEvent[]> {
    const response = await fetch(
      `${server().url}/api/sessions/${sessionId}/events?since_seq=0`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { events: StoredEvent[] }).events;
  }

  test("the original payload is retrievable for every Event", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const batch: NormalEvent[] = [
      sessionStarted({
        sessionId,
        raw: { type: "session.created", marker: "start" },
      }),
      turnStarted({
        sessionId,
        turnId,
        raw: { type: "message.user", marker: "prompt" },
      }),
      modelRequest({
        sessionId,
        turnId,
        raw: { type: "session.step.ended", marker: "model" },
      }),
      turnEnded({
        sessionId,
        turnId,
        raw: { type: "message.assistant", marker: "reply" },
      }),
      sessionEnded({
        sessionId,
        raw: { type: "session.idle", marker: "end" },
      }),
    ];

    expect((await ship(batch)).status).toBe(202);

    const stored = await readEvents(sessionId);
    expect(stored).toHaveLength(batch.length);

    // Every Event's stored raw payload is the exact payload that was shipped.
    const sentRaw = new Map(batch.map((event) => [event.id, event.raw]));
    for (const entry of stored) {
      expect(entry.raw).toEqual(sentRaw.get(entry.event.id));
    }
  });

  test("the coding agent identifier and version are recorded on every Event", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const batch: NormalEvent[] = [
      sessionStarted({ sessionId, agent: "opencode", agentVersion: "2.0.26" }),
      turnStarted({
        sessionId,
        turnId,
        agent: "opencode",
        agentVersion: "2.0.27",
      }),
    ];

    expect((await ship(batch)).status).toBe(202);

    const stored = await readEvents(sessionId);
    const sent = new Map(
      batch.map((event) => [
        event.id,
        { agent: event.agent, agentVersion: event.agentVersion },
      ]),
    );
    for (const entry of stored) {
      const identity = sent.get(entry.event.id)!;
      expect(entry.event.agent).toBe(identity.agent);
      expect(entry.event.agentVersion).toBe(identity.agentVersion);
    }
  });

  test("an Event with no original payload is rejected rather than stored bare", async () => {
    const sessionId = randomUUID();
    const { raw: _omitted, ...withoutRaw } = sessionStarted({ sessionId });

    const response = await ship([withoutRaw]);

    expect(response.status).toBe(400);
    const sessions = (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as unknown[];
    expect(sessions).toEqual([]);
  });
});
