/**
 * The Listener: normalize OpenCode events and ship them to the Server in
 * batches over the typed client.
 *
 * It runs inside OpenCode's own runtime, so it has two hard rules: never throw
 * into the host, and never block OpenCode's critical path. Normalizing an event
 * is synchronous and cheap; shipping happens off the event loop, and every
 * failure is reported rather than thrown.
 */
import type { OpenCodeEvent } from "@opencode/client";
import type { NormalEvent } from "@slopwatch/events";
import { sendEvents } from "@slopwatch/events";
import { Normalizer } from "./normalize";
import { consoleReport, describeEvent, type Report } from "./report";

export interface ListenerOptions {
  /** The Server's base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** The bearer token minted for this developer's User. */
  token: string;
  /** How many Events to accumulate before shipping a batch. Defaults to 50. */
  batchSize?: number;
  /** How long to wait before shipping a partial batch. Defaults to 2000ms. */
  flushIntervalMs?: number;
  /** The running OpenCode version, for Events that do not carry one. */
  agentVersion?: string;
  /** Fallback working directory, from the plugin's location. */
  directory?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Where normalization and shipping problems are reported. */
  report?: Report;
}

export interface Listener {
  /** Normalize one OpenCode event and queue it. Never throws. */
  handleEvent(event: OpenCodeEvent): void;
  /** Ship everything queued now. Never throws. */
  flush(): Promise<void>;
  /** Stop the flush timer and ship what is left. */
  stop(): Promise<void>;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

export function createListener(options: ListenerOptions): Listener {
  const report = options.report ?? consoleReport;
  const normalizer = new Normalizer({
    agentVersion: options.agentVersion ?? "unknown",
    directory: options.directory ?? process.cwd(),
    report,
  });
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  const queue: NormalEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    if (timer !== null || flushIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  function enqueue(events: NormalEvent[]): void {
    if (events.length === 0) return;
    queue.push(...events);
    if (queue.length >= batchSize) {
      void flush();
    } else {
      schedule();
    }
  }

  async function ship(): Promise<void> {
    clearTimer();
    const batch = queue.splice(0, queue.length);
    try {
      await sendEvents({
        baseUrl: options.baseUrl,
        token: options.token,
        events: batch,
        fetch: options.fetch,
      });
    } catch (error) {
      // The Server rejecting a batch surfaces loudly. Surviving an outage is
      // the offline-spool ticket (#11); v1's Listener reports and moves on.
      report("failed to ship Events to the Server", error);
    }
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();
    inFlight = ship().finally(() => {
      inFlight = null;
      if (queue.length > 0) schedule();
    });
    return inFlight;
  }

  return {
    handleEvent(event) {
      try {
        enqueue(normalizer.handle(event));
      } catch (error) {
        report(
          `failed to handle OpenCode event ${describeEvent(event)}`,
          error,
        );
      }
    },
    flush,
    async stop() {
      clearTimer();
      // Drain whatever is queued, including anything enqueued mid-flight.
      while (queue.length > 0 || inFlight !== null) await flush();
    },
  };
}
