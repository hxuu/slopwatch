import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import { sessionStarted } from "./test/events";

interface CreatedUser {
  id: string;
  name: string;
  email: string;
  token: string;
}

interface SearchUser {
  id: string;
  name: string;
  email: string;
}

interface SearchSession {
  id: string;
  agent: string;
  cwd: string | null;
  user: SearchUser;
}

interface SearchResults {
  sessions: { count: number; results: SearchSession[] };
  users: { count: number; results: SearchUser[] };
}

/**
 * Search across Sessions and Users, observed only through the Server's HTTP
 * API and its rendered pages. Fixtures name their own cwd and coding agent, so
 * every match is one the test put there rather than an incidental one.
 */
describeServer("search across Sessions and Users", (server) => {
  let alice: CreatedUser;

  beforeEach(async () => {
    alice = await server().createUser("Alice Nakamura", "alice@example.com");
  });

  async function ship(token: string, events: unknown[]): Promise<void> {
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

  async function search(query: string): Promise<SearchResults> {
    const response = await fetch(
      `${server().url}/api/search?q=${encodeURIComponent(query)}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as SearchResults;
  }

  test("matches Sessions by id, cwd, and coding agent, case-insensitively", async () => {
    const rocketSession = randomUUID();
    const blogSession = randomUUID();
    await ship(alice.token, [
      sessionStarted({
        sessionId: rocketSession,
        cwd: "/home/alice/rocket",
        agent: "opencode",
      }),
    ]);
    await ship(alice.token, [
      sessionStarted({
        sessionId: blogSession,
        cwd: "/home/alice/blog",
        agent: "claude-code",
      }),
    ]);

    const byCwd = await search("ROCKET");
    expect(byCwd.sessions.results.map((s) => s.id)).toEqual([rocketSession]);

    const byId = await search(blogSession);
    expect(byId.sessions.results.map((s) => s.id)).toEqual([blogSession]);

    const byAgent = await search("claude-code");
    expect(byAgent.sessions.results.map((s) => s.id)).toEqual([blogSession]);
  });

  test("matches Users by name and email, case-insensitively", async () => {
    await server().createUser("Bob Stone", "bob@example.com");

    const byName = await search("bob stone");
    expect(byName.users.results.map((u) => u.email)).toEqual([
      "bob@example.com",
    ]);

    const byEmail = await search("BOB@EXAMPLE.COM");
    expect(byEmail.users.results.map((u) => u.name)).toEqual(["Bob Stone"]);
  });

  test("reports how many results each category returned", async () => {
    await ship(alice.token, [
      sessionStarted({ sessionId: randomUUID(), cwd: "/home/alice/widgets" }),
    ]);
    await ship(alice.token, [
      sessionStarted({ sessionId: randomUUID(), cwd: "/home/alice/widgets" }),
    ]);

    const results = await search("widgets");

    expect(results.sessions.count).toBe(2);
    expect(results.sessions.results).toHaveLength(2);
    expect(results.users.count).toBe(0);
    expect(results.users.results).toHaveLength(0);
  });

  test("a query with no matches is an empty result, not an error", async () => {
    await ship(alice.token, [sessionStarted({ sessionId: randomUUID() })]);

    const results = await search("nothing-matches-this");

    expect(results.sessions).toEqual({ count: 0, results: [] });
    expect(results.users).toEqual({ count: 0, results: [] });
  });

  test("treats a LIKE metacharacter as literal text, not a wildcard", async () => {
    await ship(alice.token, [
      sessionStarted({ sessionId: randomUUID(), cwd: "/home/alice/100%" }),
    ]);

    // `%` as a wildcard would match every Session; as literal text it matches
    // only the one cwd that contains a percent sign.
    const results = await search("%");

    expect(results.sessions.count).toBe(1);
    expect(results.users.count).toBe(0);
  });

  test("renders a search box, and results link to the Session and the User", async () => {
    const sessionId = randomUUID();
    await ship(alice.token, [
      sessionStarted({ sessionId, cwd: "/home/alice/rocket" }),
    ]);

    const sessionsPage = await (
      await fetch(`${server().url}/search?q=rocket`)
    ).text();
    expect(sessionsPage).toContain('name="q"');
    expect(sessionsPage).toContain(`/sessions/${sessionId}`);

    const usersPage = await (
      await fetch(`${server().url}/search?q=alice`)
    ).text();
    expect(usersPage).toContain(`/users/${alice.id}`);
  });

  test("a User result's page lists that User's Sessions", async () => {
    const sessionId = randomUUID();
    await ship(alice.token, [sessionStarted({ sessionId })]);

    const response = await fetch(`${server().url}/users/${alice.id}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Alice Nakamura");
    expect(body).toContain(`/sessions/${sessionId}`);
  });

  test("an unknown User page is a 404", async () => {
    const response = await fetch(`${server().url}/users/${randomUUID()}`);

    expect(response.status).toBe(404);
  });

  test("a malformed User id is a 404, not a 500", async () => {
    const response = await fetch(`${server().url}/users/not-a-uuid`);

    expect(response.status).toBe(404);
  });

  test("a path segment with malformed percent-encoding is a 404, not a 500", async () => {
    const response = await fetch(`${server().url}/users/%`);

    expect(response.status).toBe(404);
  });
});
