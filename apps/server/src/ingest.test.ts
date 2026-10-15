import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import { sendEvents } from "@slopwatch/events";
import { describeServer } from "./test/harness";
import { sessionStarted, turnEnded, turnStarted } from "./test/events";

describeServer("ingestion", (server) => {
  async function ship(token: string, events: unknown[]): Promise<Response> {
    return fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });
  }

  async function sessions(): Promise<
    Array<{ id: string; user: { id: string }; turnCount: number }>
  > {
    return (await (
      await fetch(`${server().url}/api/sessions`)
    ).json()) as Array<{ id: string; user: { id: string }; turnCount: number }>;
  }

  async function createUser(): Promise<{ id: string; token: string }> {
    return server().createUser("Alice", "alice@example.com");
  }

  test("requires a bearer token and rejects an unauthenticated batch", async () => {
    const response = await fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [sessionStarted()] }),
    });

    expect(response.status).toBe(401);
    expect(await sessions()).toEqual([]);
  });

  test("attributes Events to the token's User, not to a claim in the payload", async () => {
    const alice = await createUser();
    const bob = await server().createUser("Bob", "bob@example.com");
    const sessionId = randomUUID();

    // The raw payload falsely claims to belong to Bob; the token decides.
    const event = sessionStarted({
      sessionId,
      raw: { type: "session.created", userId: bob.id, user: "bob@example.com" },
    });
    const response = await ship(alice.token, [event]);

    expect(response.status).toBe(202);
    const listed = await sessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(sessionId);
    expect(listed[0].user.id).toBe(alice.id);
  });

  test("replaying the same batch does not duplicate data", async () => {
    const user = await createUser();
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const batch: NormalEvent[] = [
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ];

    const first = await ship(user.token, batch);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: 3 });

    const replay = await ship(user.token, batch);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: 0 });

    const listed = await sessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].turnCount).toBe(1);

    const detail = await (
      await fetch(`${server().url}/api/sessions/${sessionId}`)
    ).json();
    expect((detail as { turns: unknown[] }).turns).toHaveLength(1);
  });

  test("rejects an Event that does not match the schema", async () => {
    const user = await createUser();

    const response = await ship(user.token, [{ kind: "nonsense" }]);

    expect(response.status).toBe(400);
    expect(await sessions()).toEqual([]);
  });

  test("the typed client ships a batch the Server accepts", async () => {
    const user = await createUser();
    const sessionId = randomUUID();
    const events: NormalEvent[] = [
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, prompt: "wire up the client" }),
    ];

    const result = await sendEvents({
      baseUrl: server().url,
      token: user.token,
      events,
    });

    expect(result).toEqual({ accepted: 2 });
    expect((await sessions()).map((session) => session.id)).toEqual([
      sessionId,
    ]);
  });
});
