import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import { sessionStarted, turnEnded, turnStarted } from "./test/events";

describeServer("server-rendered dashboard", (server) => {
  let token: string;

  beforeEach(async () => {
    token = (await server().createUser("Alice", "alice@example.com")).token;
  });

  async function ship(events: unknown[]): Promise<void> {
    await fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });
  }

  test("lists Sessions with their owner and Turn count", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId }),
      turnEnded({ sessionId, turnId }),
    ]);

    const response = await fetch(`${server().url}/`);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain(sessionId);
    expect(body).toContain("Alice");
    expect(body).toContain(`/sessions/${sessionId}`);
  });

  test("shows one Session with its Turns' prompt and response", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId, prompt: "add a health check" }),
      turnEnded({ sessionId, turnId, response: "Added GET /health." }),
    ]);

    const response = await fetch(`${server().url}/sessions/${sessionId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("add a health check");
    expect(body).toContain("Added GET /health.");
  });

  test("escapes user content rather than rendering it", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({
        sessionId,
        turnId,
        prompt: "<script>alert('xss')</script>",
      }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${sessionId}`)
    ).text();

    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
  });

  test("an unknown Session page is a 404", async () => {
    const response = await fetch(`${server().url}/sessions/does-not-exist`);

    expect(response.status).toBe(404);
  });
});
