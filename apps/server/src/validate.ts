import type { NormalEvent } from "@slopwatch/events";

const KINDS = new Set<NormalEvent["kind"]>([
  "session.started",
  "session.ended",
  "turn.started",
  "turn.ended",
  "message",
  "tool.call",
  "tool.result",
  "model.request",
]);

const TURN_SCOPED = new Set<NormalEvent["kind"]>([
  "turn.started",
  "turn.ended",
  "message",
  "tool.call",
  "tool.result",
  "model.request",
]);

/**
 * A structural check that an incoming value is a NormalEvent. The Server trusts
 * this shape, so a drifting Listener that ships something else is rejected
 * loudly rather than persisted half-formed.
 */
export function isNormalEvent(value: unknown): value is NormalEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;

  if (!isNonEmptyString(event.id)) return false;
  if (!isNonEmptyString(event.sessionId)) return false;
  if (
    typeof event.kind !== "string" ||
    !KINDS.has(event.kind as NormalEvent["kind"])
  ) {
    return false;
  }
  if (!isNonEmptyString(event.agent) || !isNonEmptyString(event.agentVersion)) {
    return false;
  }
  if (
    typeof event.occurredAt !== "string" ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    return false;
  }
  // Raw-payload retention: every Event must carry the original agent payload.
  if (!("raw" in event)) return false;
  if (TURN_SCOPED.has(event.kind as NormalEvent["kind"])) {
    if (!isNonEmptyString(event.turnId)) return false;
  }
  if (event.kind === "model.request") {
    if (!isNonEmptyString(event.provider)) return false;
    if (!isNonEmptyString(event.model)) return false;
    if (!isCount(event.inputTokens) || !isCount(event.outputTokens)) {
      return false;
    }
    if (event.latencyMs !== undefined && !isCount(event.latencyMs))
      return false;
    if (event.costUsd !== undefined && !isCost(event.costUsd)) return false;
  }

  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A non-negative integer, as token counts and latencies must be. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A finite, non-negative dollar amount. */
function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
