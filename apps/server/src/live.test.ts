import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import { describeServer } from "./test/harness";
import {
  modelRequest,
  sessionStarted,
  turnEnded,
  turnStarted,
} from "./test/events";

describeServer("live spectate", (server) => {
  let token: string;

  beforeEach(async () => {
    token = (await server().createUser("Alice", "alice@example.com")).token;
  });

  async function ship(events: unknown[]): Promise<void> {
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

  interface StoredEvent {
    seq: number;
    event: NormalEvent;
  }

  async function poll(sessionId: string, sinceSeq: number) {
    const response = await fetch(
      `${server().url}/api/sessions/${sessionId}/events?since_seq=${sinceSeq}`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { events: StoredEvent[] }).events;
  }

  test("a Session's live view ships an incremental poller, not a whole-Session refetch", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${sessionId}`)
    ).text();

    const feed = elementWithId(body, "live-events");
    expect(feed).toContain(`data-session-id="${sessionId}"`);
    // Seeded at the Session's sequence, so the page appends only what happens
    // next rather than refetching the three Events already in the Turn tree.
    expect(feed).toContain('data-since-seq="3"');

    // "every ~5s": the interval is data-driven, so it is asserted here rather
    // than hardcoded in the script in two places.
    const pollMs = Number(attribute(feed, "data-poll-ms"));
    expect(pollMs).toBeGreaterThanOrEqual(3000);
    expect(pollMs).toBeLessThanOrEqual(7000);

    // Appends only the increment...
    expect(body).toContain("since_seq=");
    // ...and refreshes when the tab regains focus.
    expect(body).toContain("visibilitychange");
  });

  test("polling from a known sequence appends exactly the newer Events, with no gaps or duplicates", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const shipped: string[] = [];
    const seen: StoredEvent[] = [];
    let sinceSeq = 0;

    async function catchUp(): Promise<void> {
      for (const stored of await poll(sessionId, sinceSeq)) {
        if (stored.seq <= sinceSeq) continue;
        seen.push(stored);
        sinceSeq = stored.seq;
      }
    }

    const opening = [
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
    ];
    await ship(opening);
    shipped.push(...opening.map((event) => event.id));
    await catchUp();

    const closing = [
      modelRequest({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ];
    await ship(closing);
    shipped.push(...closing.map((event) => event.id));
    await catchUp();

    // A poll with nothing new appends nothing.
    const beforeQuiet = seen.length;
    await catchUp();
    expect(seen.length).toBe(beforeQuiet);

    expect(seen.map((stored) => stored.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.map((stored) => stored.event.id)).toEqual(shipped);
  });

  test("a Session still being written to keeps advancing the live view", async () => {
    const sessionId = randomUUID();
    const firstTurn = randomUUID();
    await ship([sessionStarted({ sessionId })]);

    // No `session.ended` yet: the Session is mid-flight and each poll must
    // return the increment without waiting for it to finish.
    await ship([turnStarted({ sessionId, turnId: firstTurn, prompt: "one" })]);
    const first = await poll(sessionId, 0);
    expect(first.map((stored) => stored.event.kind)).toEqual([
      "session.started",
      "turn.started",
    ]);

    await ship([
      turnEnded({ sessionId, turnId: firstTurn, response: "done" }),
      turnStarted({ sessionId, turnId: randomUUID(), prompt: "two" }),
    ]);
    const second = await poll(sessionId, 2);
    expect(second.map((stored) => stored.seq)).toEqual([3, 4]);
    expect(second.map((stored) => stored.event.kind)).toEqual([
      "turn.ended",
      "turn.started",
    ]);
  });

  test("the sequence stays monotonic under concurrent ingestion", async () => {
    const sessionId = randomUUID();
    const batches: NormalEvent[][] = Array.from({ length: 8 }, (_, batch) =>
      Array.from({ length: 5 }, (_, index) =>
        turnStarted({
          sessionId,
          turnId: randomUUID(),
          prompt: `batch ${batch} event ${index}`,
        }),
      ),
    );
    batches[0]!.unshift(sessionStarted({ sessionId }));

    await Promise.all(
      batches.map((batch) =>
        fetch(`${server().url}/api/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ events: batch }),
        }),
      ),
    );

    const total = batches.reduce((sum, batch) => sum + batch.length, 0);
    const all = await poll(sessionId, 0);

    // Contiguous from 1 with no gaps, and no Event stored twice.
    expect(all.map((stored) => stored.seq)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
    const ids = all.map((stored) => stored.event.id);
    expect(new Set(ids).size).toBe(total);
  });

  test("an unknown Session's Events endpoint is a 404", async () => {
    const response = await fetch(
      `${server().url}/api/sessions/does-not-exist/events?since_seq=0`,
    );

    expect(response.status).toBe(404);
  });

  test("a negative or non-integer since_seq is rejected", async () => {
    const sessionId = randomUUID();
    await ship([sessionStarted({ sessionId })]);

    for (const sinceSeq of ["-1", "1.5", "nope"]) {
      const response = await fetch(
        `${server().url}/api/sessions/${sessionId}/events?since_seq=${sinceSeq}`,
      );
      expect(response.status).toBe(400);
    }
  });
});

/** The opening tag of the element carrying this id, e.g. `<ol id="live-events" …>`. */
function elementWithId(html: string, id: string): string {
  const match = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`).exec(html);
  expect(match, `no element with id ${id}`).not.toBeNull();
  return match![0];
}

/** The value of one attribute on an opening tag. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}
