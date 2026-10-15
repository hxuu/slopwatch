import { expect, test } from "bun:test";
import { describeServer } from "./test/harness";
import { sessionStarted } from "./test/events";

interface CreatedUser {
  id: string;
  name: string;
  email: string;
  token: string;
}

interface ListedUser {
  id: string;
  name: string;
  email: string;
}

/**
 * The admin plane: an admin adds a User and receives a token once, lists Users,
 * and revokes a token. These tests drive it over HTTP, never through the
 * Server's internals, so a token is observed exactly as an admin would see it.
 */
describeServer("admin: mint, list, and revoke Users and tokens", (server) => {
  function adminRequest(
    path: string,
    init: RequestInit = {},
    token: string | null = server().adminToken,
  ): Promise<Response> {
    return fetch(`${server().url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  }

  function addUser(body: unknown, token?: string | null): Promise<Response> {
    return adminRequest(
      "/api/admin/users",
      { method: "POST", body: JSON.stringify(body) },
      token,
    );
  }

  function listUsers(token?: string | null): Promise<Response> {
    return adminRequest("/api/admin/users", {}, token);
  }

  function revokeUser(
    userId: string,
    token?: string | null,
  ): Promise<Response> {
    return adminRequest(
      `/api/admin/users/${userId}/revoke`,
      { method: "POST" },
      token,
    );
  }

  function shipEvents(token: string, events: unknown[]): Promise<Response> {
    return fetch(`${server().url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    });
  }

  async function createUser(
    name = "Alice",
    email = "alice@example.com",
  ): Promise<CreatedUser> {
    return (await (await addUser({ name, email })).json()) as CreatedUser;
  }

  test("mints a long-lived token for the new User, shown once", async () => {
    const response = await addUser({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as CreatedUser;
    expect(created.name).toBe("Alice");
    expect(created.email).toBe("alice@example.com");
    expect(created.token).toStartWith("slop_");
  });

  test("rejects an admin request without the admin token", async () => {
    const response = await addUser(
      { name: "Mallory", email: "mallory@example.com" },
      null,
    );

    expect(response.status).toBe(401);
  });

  test("rejects an admin request with the wrong admin token", async () => {
    const response = await addUser(
      { name: "Mallory", email: "mallory@example.com" },
      "slop_admin_wrong",
    );

    expect(response.status).toBe(401);
  });

  test("conflicts when a User with that email already exists", async () => {
    await addUser({ name: "Alice", email: "alice@example.com" });

    const response = await addUser({
      name: "Alice Again",
      email: "alice@example.com",
    });

    expect(response.status).toBe(409);
  });

  test("lists Users with their identity fields", async () => {
    const alice = await createUser();
    const bob = await createUser("Bob", "bob@example.com");

    const response = await listUsers();

    expect(response.status).toBe(200);
    const users = (await response.json()) as ListedUser[];
    expect(users).toEqual([
      { id: alice.id, name: "Alice", email: "alice@example.com" },
      { id: bob.id, name: "Bob", email: "bob@example.com" },
    ]);
  });

  test("does not make the token retrievable once the User is created", async () => {
    const created = await createUser();

    const response = await listUsers();
    const body = await response.text();

    // Neither the token nor a hash of it ever leaves the Server again.
    expect(body).not.toContain(created.token);
    const listed = (JSON.parse(body) as ListedUser[]).find(
      (user) => user.id === created.id,
    );
    expect(listed).toEqual({
      id: created.id,
      name: created.name,
      email: created.email,
    });
  });

  test("requires the admin token to list Users", async () => {
    await createUser();

    const response = await listUsers(null);

    expect(response.status).toBe(401);
  });

  test("requires the admin token to revoke a token", async () => {
    const created = await createUser();

    const response = await revokeUser(created.id, null);

    expect(response.status).toBe(401);
  });

  test("a revoked token is rejected on its next ingestion attempt", async () => {
    const created = await createUser();

    const before = await shipEvents(created.token, [sessionStarted()]);
    expect(before.status).toBe(202);

    const revoked = await revokeUser(created.id);
    expect(revoked.status).toBe(204);

    const after = await shipEvents(created.token, [sessionStarted()]);
    expect(after.status).toBe(401);
  });

  test("revoking an unknown User reports 404", async () => {
    const response = await revokeUser("00000000-0000-0000-0000-000000000000");

    expect(response.status).toBe(404);
  });
});
