import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SecretStoreOptions,
  TOKEN_NAME,
  openSecretStore,
  readStoredToken,
} from "./token";

const scratch = mkdtempSync(join(tmpdir(), "slopwatch-listener-"));

function filePath(name: string): string {
  return join(scratch, `${name}.json`);
}

// A keychain that always reports itself unavailable, standing in for a headless
// Linux box with no Secret Service.
const noKeychain: NonNullable<SecretStoreOptions["keychain"]> = () => {
  throw new Error("no Secret Service available");
};

describe("the Listener's token store", () => {
  test("falls back to a 0600 file when no keychain is available", async () => {
    const path = filePath("fallback");
    const store = await openSecretStore({
      keychain: noKeychain,
      filePath: path,
    });

    expect(store.backend).toBe("file");
    await store.set(TOKEN_NAME, "slop_file");

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      await readStoredToken({ keychain: noKeychain, filePath: path }),
    ).toBe("slop_file");
  });

  test("reads the token through the OS keychain when one is available", async () => {
    const secrets = new Map<string, string>();
    const keychain: NonNullable<SecretStoreOptions["keychain"]> = (
      _service,
      account,
    ) => ({
      getPassword: () => secrets.get(account) ?? null,
      setPassword: (value) => {
        secrets.set(account, value);
      },
      deletePassword: () => secrets.delete(account),
    });

    const store = await openSecretStore({ keychain });
    expect(store.backend).toBe("os-keychain");

    await store.set(TOKEN_NAME, "slop_keychain");
    expect(await readStoredToken({ keychain })).toBe("slop_keychain");
  });

  test("reports no token when nothing has been stored", async () => {
    expect(
      await readStoredToken({
        keychain: noKeychain,
        filePath: filePath("empty"),
      }),
    ).toBeNull();
  });
});
