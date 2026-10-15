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

  test("renders a branching Session as a Turn tree, not a flattened list", async () => {
    const sessionId = randomUUID();
    const root = randomUUID();
    const leftBranch = randomUUID();
    const rightBranch = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId: root, prompt: "explain the schema" }),
      turnEnded({ sessionId, turnId: root, response: "Here is the schema." }),
      turnStarted({
        sessionId,
        turnId: leftBranch,
        parentTurnId: root,
        prompt: "what about the events table",
      }),
      turnEnded({
        sessionId,
        turnId: leftBranch,
        response: "It is append-only.",
      }),
      turnStarted({
        sessionId,
        turnId: rightBranch,
        parentTurnId: root,
        prompt: "and the rollups",
      }),
      turnEnded({
        sessionId,
        turnId: rightBranch,
        response: "They are a cache.",
      }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${sessionId}`)
    ).text();

    const rendered = renderedTurns(body);
    expect(rendered.map((turn) => turn.id)).toEqual([
      root,
      leftBranch,
      rightBranch,
    ]);
    expect(rendered.filter((turn) => turn.depth === 0)).toHaveLength(1);
    expect(findTurn(rendered, root)).toMatchObject({
      parentId: null,
      depth: 0,
    });
    expect(findTurn(rendered, leftBranch)).toMatchObject({
      parentId: root,
      depth: 1,
    });
    expect(findTurn(rendered, rightBranch)).toMatchObject({
      parentId: root,
      depth: 1,
    });
  });

  test("renders a linear Session as a straight chain", async () => {
    const sessionId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({ sessionId, turnId: first, prompt: "add a health check" }),
      turnEnded({ sessionId, turnId: first }),
      turnStarted({
        sessionId,
        turnId: second,
        parentTurnId: first,
        prompt: "add a test for it",
      }),
      turnEnded({ sessionId, turnId: second }),
      turnStarted({
        sessionId,
        turnId: third,
        parentTurnId: second,
        prompt: "run the suite",
      }),
      turnEnded({ sessionId, turnId: third }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${sessionId}`)
    ).text();

    const rendered = renderedTurns(body);
    expect(
      rendered.map((turn) => ({ id: turn.id, depth: turn.depth })),
    ).toEqual([
      { id: first, depth: 0 },
      { id: second, depth: 1 },
      { id: third, depth: 2 },
    ]);
    expect(findTurn(rendered, second)?.parentId).toBe(first);
    expect(findTurn(rendered, third)?.parentId).toBe(second);
  });

  test("renders a Turn whose parent is absent from the Session as a root, not a drop", async () => {
    const sessionId = randomUUID();
    const orphan = randomUUID();
    await ship([
      sessionStarted({ sessionId }),
      turnStarted({
        sessionId,
        turnId: orphan,
        parentTurnId: randomUUID(),
        prompt: "resume the previous turn",
      }),
    ]);

    const body = await (
      await fetch(`${server().url}/sessions/${sessionId}`)
    ).text();

    const rendered = renderedTurns(body);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ id: orphan, depth: 0 });
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

interface RenderedTurn {
  id: string;
  parentId: string | null;
  /** How deep the Turn is nested, derived from the rendered list structure. */
  depth: number;
}

/**
 * The Turn tree exactly as the page renders it: document order, with the depth
 * each Turn is nested at read from the closing tags rather than trusted from
 * the markup's own claims.
 */
function renderedTurns(html: string): RenderedTurn[] {
  const turns: RenderedTurn[] = [];
  const stack: string[] = [];
  const token =
    /<li class="turn" data-turn-id="([^"]*)" data-parent-turn-id="([^"]*)">|<\/li>/g;
  for (const match of html.matchAll(token)) {
    if (match[0] === "</li>") {
      stack.pop();
      continue;
    }
    const [, id, parentId] = match;
    turns.push({ id, parentId: parentId || null, depth: stack.length });
    stack.push(id);
  }
  return turns;
}

function findTurn(turns: RenderedTurn[], id: string): RenderedTurn | undefined {
  return turns.find((turn) => turn.id === id);
}
