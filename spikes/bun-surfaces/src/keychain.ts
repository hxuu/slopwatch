import { Entry } from "@napi-rs/keyring";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where a secret actually lives once a store has been opened. */
export type SecretBackend = "os-keychain" | "file";

/**
 * Storage for long-lived secrets (in v1, one bearer token). Synchronous
 * underneath; async here so the file fallback has the same shape.
 */
export interface SecretStore {
  readonly backend: SecretBackend;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The slice of `@napi-rs/keyring`'s `Entry` this module depends on. */
export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export type KeychainFactory = (
  service: string,
  account: string,
) => KeychainEntry;

export interface SecretStoreOptions {
  /** Keychain service label. */
  service?: string;
  /** Where the fallback file lives, when the keychain is unavailable. */
  filePath?: string;
  /** Injectable for tests and for forcing the fallback path. */
  keychain?: KeychainFactory;
}

const DEFAULT_SERVICE = "slopwatch";

export function defaultSecretFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "slopwatch", "secrets.json");
}

function osKeychain(service: string, account: string): KeychainEntry {
  // Pin the Secret Service on Linux. Left to its default, `@napi-rs/keyring`
  // silently falls back to the in-memory kernel keyring when no Secret Service
  // is reachable, so a token would look stored and vanish on reboot. Pinning
  // makes an absent keychain throw, which is the signal to use the file.
  return new Entry(service, account, { linux: { store: "secret-service" } });
}

/**
 * Open the OS keychain, or a 0600 file when there is none (headless Linux, no
 * Secret Service daemon). Availability is decided by whether a keychain entry
 * can be opened.
 */
export async function openSecretStore(
  options: SecretStoreOptions = {},
): Promise<SecretStore> {
  const service = options.service ?? DEFAULT_SERVICE;
  const factory = options.keychain ?? osKeychain;

  try {
    factory(service, "availability-probe");
    return new KeychainSecretStore(service, factory);
  } catch {
    return new FileSecretStore(options.filePath ?? defaultSecretFilePath());
  }
}

class KeychainSecretStore implements SecretStore {
  readonly backend = "os-keychain" as const;

  constructor(
    private readonly service: string,
    private readonly factory: KeychainFactory,
  ) {}

  private entry(name: string): KeychainEntry {
    return this.factory(this.service, name);
  }

  async get(name: string): Promise<string | null> {
    return this.entry(name).getPassword();
  }

  async set(name: string, value: string): Promise<void> {
    this.entry(name).setPassword(value);
  }

  async delete(name: string): Promise<void> {
    this.entry(name).deletePassword();
  }
}

class FileSecretStore implements SecretStore {
  readonly backend = "file" as const;

  constructor(private readonly path: string) {}

  async get(name: string): Promise<string | null> {
    const secrets = await this.read();
    return secrets[name] ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    const secrets = await this.read();
    secrets[name] = value;
    await this.write(secrets);
  }

  async delete(name: string): Promise<void> {
    const secrets = await this.read();
    if (!(name in secrets)) return;
    delete secrets[name];
    await this.write(secrets);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<
        string,
        string
      >;
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw thrown;
    }
  }

  private async write(secrets: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write then rename, so an interrupted write cannot leave half a JSON file
    // where the token used to be.
    const staging = `${this.path}.${process.pid}.tmp`;
    await writeFile(staging, JSON.stringify(secrets), { mode: 0o600 });
    // `writeFile`'s mode is masked by the umask and ignored when the file
    // already exists, so force it; `rename` carries the mode to the target.
    await chmod(staging, 0o600);
    await rename(staging, this.path);
  }
}
