/**
 * Where the Listener's bearer token lives: the OS keychain, or a 0600 file when
 * there is none (headless Linux, no Secret Service daemon), so capture works on
 * servers and CI too.
 *
 * This is the productionized form of the store validated on Bun in
 * `spikes/bun-surfaces` (ADR-0001). The one non-obvious rule is inherited from
 * there: `@napi-rs/keyring` silently falls back to the in-memory kernel keyring
 * when no Secret Service is reachable, so the Linux backend is pinned to
 * `secret-service` and an absent keychain throws, which is the signal to use
 * the file.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where a secret actually lives once a store has been opened. */
export type SecretBackend = "os-keychain" | "file";

/** The key the Listener stores its token under. */
export const TOKEN_NAME = "token";

const DEFAULT_SERVICE = "slopwatch";

/** Storage for the Listener's long-lived bearer token. */
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
) => KeychainEntry | Promise<KeychainEntry>;

export interface SecretStoreOptions {
  /** Keychain service label. */
  service?: string;
  /** Where the fallback file lives, when the keychain is unavailable. */
  filePath?: string;
  /** Injectable for tests and for forcing the fallback path. */
  keychain?: KeychainFactory;
}

export function defaultSecretFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "slopwatch", "secrets.json");
}

async function osKeychain(
  service: string,
  account: string,
): Promise<KeychainEntry> {
  // Imported lazily: on a platform where the native addon is missing, this
  // throws here and the Listener falls back to the file, rather than failing to
  // load at all and taking OpenCode down with it.
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account, { linux: { store: "secret-service" } });
}

/**
 * Open the OS keychain, or a 0600 file when there is none. Availability is
 * decided by whether a keychain entry can be opened at all.
 */
export async function openSecretStore(
  options: SecretStoreOptions = {},
): Promise<SecretStore> {
  const service = options.service ?? DEFAULT_SERVICE;
  const factory = options.keychain ?? osKeychain;

  try {
    await factory(service, "availability-probe");
    return new KeychainSecretStore(service, factory);
  } catch {
    return new FileSecretStore(options.filePath ?? defaultSecretFilePath());
  }
}

/**
 * Read the stored token, or null when none has been saved. Callers decide what
 * to do about a missing token; the Listener reports and stays inactive.
 */
export async function readStoredToken(
  options: SecretStoreOptions = {},
): Promise<string | null> {
  return (await openSecretStore(options)).get(TOKEN_NAME);
}

class KeychainSecretStore implements SecretStore {
  readonly backend = "os-keychain" as const;

  constructor(
    private readonly service: string,
    private readonly factory: KeychainFactory,
  ) {}

  private async entry(name: string): Promise<KeychainEntry> {
    return this.factory(this.service, name);
  }

  async get(name: string): Promise<string | null> {
    return (await this.entry(name)).getPassword();
  }

  async set(name: string, value: string): Promise<void> {
    (await this.entry(name)).setPassword(value);
  }

  async delete(name: string): Promise<void> {
    (await this.entry(name)).deletePassword();
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
