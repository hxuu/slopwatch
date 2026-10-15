import { expect, test } from "bun:test";
import { describeServer } from "./test/harness";

describeServer("server boot and health", (server) => {
  test("boots against a Postgres URL, applies migrations, and reports health", async () => {
    const response = await fetch(`${server().url}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
