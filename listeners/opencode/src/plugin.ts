/**
 * The in-process OpenCode plugin. OpenCode loads it through its own lifecycle
 * and hands it a `Context`; the plugin subscribes to the public event stream and
 * feeds it to the Listener.
 *
 * Two rules shape this module. It does no work on OpenCode's critical path: the
 * subscription runs in its own loop and only normalizes synchronously. And it
 * never throws into the host, because it shares a runtime with the developer's
 * coding agent; every failure is reported and swallowed.
 */
import type { OpenCodeEvent } from "@opencode/client";
import { Plugin } from "@opencode/plugin";
import { createListener, type Listener } from "./listener";
import { consoleReport, type Report } from "./report";
import { readStoredToken } from "./token";

/**
 * The slice of OpenCode's plugin `Context` the Listener uses. Structurally a
 * subset of the real `Context`, so a real one is accepted without a cast and a
 * test can supply only these fields.
 */
export interface ListenerContext {
  readonly app: { readonly version: string };
  readonly location: { readonly directory: string };
  readonly options: Readonly<Record<string, unknown>>;
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpenCodeEvent>;
  };
}

/** Non-secret configuration, from plugin options, the environment, or defaults. */
export interface ListenerConfig {
  /** The Server's base URL. Defaults to `SLOPWATCH_URL` or localhost:3000. */
  url?: string;
  /** The bearer token. Defaults to `SLOPWATCH_TOKEN` or the stored token. */
  token?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  /** How many Events the offline spool holds before it evicts the oldest. */
  spoolCap?: number;
}

/** A started Listener, with a handle onto its subscription loop. */
export interface RunningListener {
  readonly listener: Listener;
  /** Resolves once the event stream ends and buffered Events are flushed. */
  readonly idle: Promise<void>;
  /** Abort the subscription and ship what is left. */
  stop(): Promise<void>;
}

/** Injectable seams for tests: where reports go and where the token is read. */
export interface ListenerDeps {
  report?: Report;
  readToken?: () => Promise<string | null>;
}

const DEFAULT_URL = "http://localhost:3000";

/**
 * Wire the Listener to an OpenCode context. Returns null (after reporting) when
 * no token is configured, so a developer without Slopwatch is left undisturbed.
 */
export async function setupListener(
  ctx: ListenerContext,
  config: ListenerConfig = {},
  deps: ListenerDeps = {},
): Promise<RunningListener | null> {
  const report = deps.report ?? consoleReport;
  const url =
    config.url ??
    optionString(ctx.options, "url") ??
    process.env.SLOPWATCH_URL ??
    DEFAULT_URL;

  const token = await resolveToken(ctx, config, deps, report);
  if (!token) {
    report("no Slopwatch token configured; the OpenCode Listener is inactive");
    return null;
  }

  const listener = createListener({
    baseUrl: url,
    token,
    agentVersion: ctx.app.version,
    directory: ctx.location.directory,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    spoolCap: config.spoolCap,
    report,
  });

  const controller = new AbortController();
  const idle = (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        listener.handleEvent(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        report("the OpenCode event stream failed", error);
      }
    } finally {
      await listener.flush();
    }
  })();

  return {
    listener,
    idle,
    async stop() {
      controller.abort();
      await idle;
      await listener.stop();
    },
  };
}

async function resolveToken(
  ctx: ListenerContext,
  config: ListenerConfig,
  deps: ListenerDeps,
  report: Report,
): Promise<string | null> {
  const token =
    config.token ??
    optionString(ctx.options, "token") ??
    process.env.SLOPWATCH_TOKEN;
  if (token) return token;

  try {
    return await (deps.readToken ?? readStoredToken)();
  } catch (error) {
    report("could not read the stored Slopwatch token", error);
    return null;
  }
}

/** The Object OpenCode loads when the package is listed as a plugin. */
export default Plugin.define({
  id: "slopwatch",
  setup: (ctx) => startListener(ctx).stop,
});

/** A Listener starting up, with a handle onto its detached startup. */
export interface StartedListener {
  /** Resolves once startup finishes, or is skipped for want of a token. */
  readonly started: Promise<void>;
  /** Stop the Listener and ship what is left. Safe before startup finishes. */
  stop(): Promise<void>;
}

/**
 * Start the Listener against an OpenCode context.
 *
 * Startup reads the OS keychain, which can block, so it runs detached and the
 * handle is returned synchronously: OpenCode's load path never waits on it.
 * `stopped` closes the race where OpenCode tears the plugin down before the
 * Listener has finished starting.
 */
export function startListener(
  ctx: ListenerContext,
  deps: ListenerDeps = {},
): StartedListener {
  let running: RunningListener | null = null;
  let stopped = false;

  const started = (async () => {
    try {
      const listener = await setupListener(ctx, {}, deps);
      if (!listener) return;
      if (stopped) {
        await listener.stop();
        return;
      }
      running = listener;
    } catch (error) {
      // A Listener defect must never destabilise the developer's coding agent.
      console.error("[slopwatch] OpenCode Listener failed to start", error);
    }
  })();

  return {
    started,
    async stop() {
      stopped = true;
      await started;
      if (running) await running.stop();
    },
  };
}

function optionString(
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
