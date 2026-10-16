/**
 * The Listener: normalize OpenCode events and ship them to the Server in
 * batches over the typed client.
 *
 * It runs inside OpenCode's own runtime, so it has two hard rules: never throw
 * into the host, and never block OpenCode's critical path. Normalizing an event
 * is synchronous and cheap; shipping happens off the event loop, and every
 * failure is reported rather than thrown.
 *
 * When the Server is unreachable the Events wait in the offline spool
 * (`./spool`) and ship in order once it returns, so a brief outage does not
 * lose a Session.
 */
import type { OpenCodeEvent } from "@opencode/client";
import type { NormalEvent } from "@slopwatch/events";
import { sendEvents, ShipEventsError } from "@slopwatch/events";
import { Normalizer } from "./normalize";
import {
  consoleReport,
  describeEvent,
  eventCount,
  type Report,
} from "./report";
import { createSpool, DEFAULT_SPOOL_CAP } from "./spool";

export interface ListenerOptions {
  /** The Server's base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** The bearer token minted for this developer's User. */
  token: string;
  /** How many Events to accumulate before shipping a batch. Defaults to 50. */
  batchSize?: number;
  /** How long to wait before shipping a partial batch. Defaults to 2000ms. */
  flushIntervalMs?: number;
  /**
   * How many Events the offline spool holds while the Server is unreachable
   * before it evicts the oldest and warns. Defaults to {@link DEFAULT_SPOOL_CAP}.
   */
  spoolCap?: number;
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
  /** Ship the oldest queued batch now. Never throws. */
  flush(): Promise<void>;
  /** Stop the flush timer, drain what the Server will take, report the rest. */
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
  const spool = createSpool({
    cap: options.spoolCap ?? DEFAULT_SPOOL_CAP,
    report,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  // A sustained outage retries every `flushIntervalMs`; report its start once
  // rather than once per attempt, and report again only after a recovery.
  let outageReported = false;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    if (stopped || timer !== null || flushIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  function enqueue(events: NormalEvent[]): void {
    if (events.length === 0) return;
    // A full spool reports its own eviction; the Listener just keeps feeding it.
    spool.append(events);
    if (spool.size >= batchSize) {
      void flush();
    } else {
      schedule();
    }
  }

  async function ship(): Promise<void> {
    clearTimer();
    const batch = spool.peek(batchSize);
    if (batch.length === 0) return;

    try {
      await sendEvents({
        baseUrl: options.baseUrl,
        token: options.token,
        events: batch,
        fetch: options.fetch,
      });
      // The Server accepted the batch, replays included, so it leaves the spool.
      spool.release(batch.length);
      outageReported = false;
    } catch (error) {
      if (isRejected(error)) {
        // A 4xx is the Server refusing these Events, not an outage. Retrying
        // would wedge the spool behind them forever, so drop them loudly: a
        // rejected batch must surface rather than block everything after it.
        report(
          `the Server rejected ${eventCount(batch.length)}; dropping them`,
          error,
        );
        spool.release(batch.length);
      } else {
        // Unreachable, or the Server failed: keep the Events, in order, for the
        // next attempt. `flush`'s `finally` schedules that attempt.
        if (!outageReported) {
          outageReported = true;
          report("failed to ship Events to the Server", error);
        }
      }
    }
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (spool.size === 0) return Promise.resolve();
    inFlight = ship().finally(() => {
      inFlight = null;
      if (spool.size > 0) schedule();
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
      stopped = true;
      clearTimer();
      // Drain what the Server will take, then give up loudly rather than hang
      // on an outage or drop what is left without a word.
      while (spool.size > 0) {
        const before = spool.size;
        await flush();
        if (spool.size >= before) break;
      }
      if (spool.size > 0) {
        report(
          `${eventCount(spool.size)} could not be shipped and are still in ` +
            `the offline spool`,
        );
      }
    },
  };
}

/**
 * Whether the Server refused a batch outright rather than being unreachable. A
 * refusal is permanent: the same Events would be refused again, so they must not
 * stay at the head of the spool. The transient 4xx codes (timeout, too early,
 * too many requests) are left for a retry.
 */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

function isRejected(error: unknown): boolean {
  return (
    error instanceof ShipEventsError &&
    error.status >= 400 &&
    error.status < 500 &&
    !TRANSIENT_STATUSES.has(error.status)
  );
}
