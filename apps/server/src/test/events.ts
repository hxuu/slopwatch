import { randomUUID } from "node:crypto";
import type {
  ModelRequestEvent,
  SessionEndedEvent,
  SessionStartedEvent,
  TurnEndedEvent,
  TurnStartedEvent,
} from "@slopwatch/events";

/**
 * Builders for valid Events, so a test names only the fields it cares about.
 * Ids default to fresh UUIDs; override them when the test must refer back.
 */
export function sessionStarted(
  overrides: Partial<SessionStartedEvent> = {},
): SessionStartedEvent {
  return {
    kind: "session.started",
    id: randomUUID(),
    sessionId: randomUUID(),
    agent: "opencode",
    agentVersion: "1.0.0",
    occurredAt: "2026-10-15T10:00:00.000Z",
    cwd: "/home/dev/project",
    raw: { type: "session.created" },
    ...overrides,
  };
}

export function sessionEnded(
  overrides: Partial<SessionEndedEvent> = {},
): SessionEndedEvent {
  return {
    kind: "session.ended",
    id: randomUUID(),
    sessionId: randomUUID(),
    agent: "opencode",
    agentVersion: "1.0.0",
    occurredAt: "2026-10-15T10:05:00.000Z",
    raw: { type: "session.idle" },
    ...overrides,
  };
}

export function turnStarted(
  overrides: Partial<TurnStartedEvent> = {},
): TurnStartedEvent {
  return {
    kind: "turn.started",
    id: randomUUID(),
    sessionId: randomUUID(),
    agent: "opencode",
    agentVersion: "1.0.0",
    occurredAt: "2026-10-15T10:01:00.000Z",
    turnId: randomUUID(),
    prompt: "rename the user table",
    raw: { type: "message.user" },
    ...overrides,
  };
}

export function turnEnded(
  overrides: Partial<TurnEndedEvent> = {},
): TurnEndedEvent {
  return {
    kind: "turn.ended",
    id: randomUUID(),
    sessionId: randomUUID(),
    agent: "opencode",
    agentVersion: "1.0.0",
    occurredAt: "2026-10-15T10:02:00.000Z",
    turnId: randomUUID(),
    response: "Renamed the table and updated the migration.",
    raw: { type: "message.assistant" },
    ...overrides,
  };
}

export function modelRequest(
  overrides: Partial<ModelRequestEvent> = {},
): ModelRequestEvent {
  return {
    kind: "model.request",
    id: randomUUID(),
    sessionId: randomUUID(),
    agent: "opencode",
    agentVersion: "1.0.0",
    occurredAt: "2026-10-15T10:01:30.000Z",
    turnId: randomUUID(),
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputTokens: 1_200,
    outputTokens: 80,
    raw: { type: "session.step.ended" },
    ...overrides,
  };
}
