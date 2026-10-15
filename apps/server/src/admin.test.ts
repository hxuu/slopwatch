import { expect, test } from "bun:test";
import { describeServer } from "./test/harness";

describeServer("admin: add a User and mint a token", (server) => {
  function addUser(
    body: unknown,
    token: string | null = server().adminToken,
  ): Promise<Response> {
    return fetch(`${server().url}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  test("mints a long-lived token for the new User, shown once", async () => {
    const response = await addUser({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      name: string;
      email: string;
      token: string;
    };
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
});
