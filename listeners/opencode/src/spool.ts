/**
 * The offline spool: a bounded, append-only buffer of the Events the Listener
 * could not ship because the Server was unreachable.
 *
 * It is the one place a Listener tolerates loss, and the bound is deliberate: a
 * Server that never returns must not grow the Listener without limit. When the
 * cap is reached the newest Events are kept and the oldest are evicted, the
 * direction the chain is drained in, and the eviction is reported loudly with a
 * running count. A dropped Turn reads as "the developer did nothing", so
 * truncation is never silent.
 *
 * Keeping the newest is not arbitrary: it preserves a Session's closing Events,
 * so a Session finished during the outage does not read as active forever, and
 * it preserves a Subagent's `session.started`, so its link to the spawning Turn
 * survives.
 *
 * The spool is in memory: it covers an outage for as long as the Listener runs,
 * which is the duration of the developer's Session. Surviving the OpenCode
 * process exiting would need an always-on daemon, which v1 does not have.
 */
import type { NormalEvent } from "@slopwatch/events";
import { eventCount, type Report } from "./report";

/** How many Events the spool holds before it starts evicting the oldest. */
export const DEFAULT_SPOOL_CAP = 10_000;

export interface SpoolOptions {
  /** The maximum number of Events held before the oldest are evicted. */
  cap?: number;
  /** Where a full-spool warning goes. Never thrown. */
  report: Report;
}

/**
 * A bounded, append-only queue of Events awaiting the Server. Events leave only
 * through `release`, which the Listener calls once the Server has accepted them,
 * so a failed ship leaves the spool untouched and still in order.
 */
export interface Spool {
  readonly size: number;
  /** Append Events in order. When full, the oldest are evicted and reported. */
  append(events: NormalEvent[]): void;
  /** The oldest up to `count` Events, without removing them. */
  peek(count: number): NormalEvent[];
  /** Remove the oldest `count` Events, once the Server has accepted them. */
  release(count: number): void;
}

export function createSpool(options: SpoolOptions): Spool {
  const cap = options.cap ?? DEFAULT_SPOOL_CAP;
  const events: NormalEvent[] = [];
  let dropped = 0;

  return {
    get size() {
      return events.length;
    },

    append(batch) {
      if (batch.length === 0) return;
      // Keep only the newest `cap` Events across the spool and the batch. An
      // oversized single batch is trimmed before it is considered, so the spool
      // can never exceed the cap.
      let incoming = batch;
      let droppedNow = 0;
      if (incoming.length >= cap) {
        droppedNow += incoming.length - cap;
        incoming = incoming.slice(incoming.length - cap);
      }
      const overflow = events.length + incoming.length - cap;
      if (overflow > 0) {
        events.splice(0, overflow);
        droppedNow += overflow;
      }
      events.push(...incoming);

      if (droppedNow === 0) return;
      dropped += droppedNow;
      options.report(
        `the offline spool is full (cap ${cap}); evicted the oldest ` +
          `${eventCount(droppedNow)}, which will not reach the Server ` +
          `(${dropped} dropped in total)`,
      );
    },

    peek(count) {
      return events.slice(0, Math.max(0, count));
    },

    release(count) {
      events.splice(0, Math.max(0, count));
    },
  };
}
