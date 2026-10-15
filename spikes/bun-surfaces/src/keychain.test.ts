import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretStoreOptions, openSecretStore } from "./keychain";

const scratch = mkdtempSync(join(tmpdir(), "slopwatch-spike-"));

function fileFallback(name: string): string {
  return join(scratch, `${name}.json`);
}

// A keychain that always reports itself unavailable, standing in for a
// headless Linux box with no Secret Service.
const noKeychain: NonNullable<SecretStoreOptions["keychain"]> = () => {
  throw new Error("no Secret Service available");
};

// Probe what this machine actually offers, so the "real keychain" test can be
// skipped where there is none.
const nativeBackend = (
  await openSecretStore({ filePath: fileFallback("probe") })
).backend;

describe("secret storage", () => {
  test("round-trips a secret through whichever backend this machine has", async () => {
    const store = await openSecretStore({
      service: "slopwatch-spike",
      filePath: fileFallback("roundtrip"),
    });

    await store.set("token", "s3cr3t");
    expect(await store.get("token")).toBe("s3cr3t");
    await store.delete("token");
    expect(await store.get("token")).toBeNull();
  });

  test("falls back to a 0600 file when no keychain is available", async () => {
    const path = fileFallback("fallback");
    const store = await openSecretStore({
      keychain: noKeychain,
      filePath: path,
    });

    expect(store.backend).toBe("file");
    await store.set("token", "file-only");

    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A fresh store, as a later process would open it.
    const reopened = await openSecretStore({
      keychain: noKeychain,
      filePath: path,
    });
    expect(await reopened.get("token")).toBe("file-only");
  });

  test.skipIf(nativeBackend !== "os-keychain")(
    "writes and reads through the OS keychain when one is present",
    async () => {
      const options: SecretStoreOptions = {
        service: "slopwatch-spike",
        filePath: fileFallback("native"),
      };
      const store = await openSecretStore(options);
      expect(store.backend).toBe("os-keychain");

      await store.set("token", "keychain-only");
      try {
        // Reads back through a fresh entry, i.e. it really landed in the store.
        const reopened = await openSecretStore(options);
        expect(await reopened.get("token")).toBe("keychain-only");
      } finally {
        await store.delete("token");
      }
    },
  );
});
