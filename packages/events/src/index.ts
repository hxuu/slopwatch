/**
 * `NormalEvent`: the normalized record a Listener produces and ships to the
 * Server. This package is the one shared contract between every Listener and
 * the Server, so it stays free of runtime dependencies.
 */

/** The coding agents Slopwatch can observe. */
export type CodingAgent =
  | "claude-code"
  | "codex"
  | "copilot"
  | "opencode"
  | "pi";

/**
 * The fields every Event carries, whatever its kind.
 *
 * `agent` and `agentVersion` are on every Event because schema drift is a
 * certainty, not a risk: after the fact, "which version of the coding agent
 * produced this" is the first question asked. `raw` retains the original agent
 * payload unmodified, so a normalization gap can be diagnosed and replayed.
 */
export interface NormalEventBase {
  /** Stable identifier the Listener assigns. Ingestion dedupes on it. */
  id: string;
  /** The Session this Event belongs to. */
  sessionId: string;
  /** Which Coding agent produced the Event. */
  agent: CodingAgent;
  /** The version of that coding agent, for diagnosing schema drift. */
  agentVersion: string;
  /** When the Event happened, as an ISO-8601 timestamp. */
  occurredAt: string;
  /** The original agent payload, retained unmodified for fidelity. */
  raw: unknown;
}

/** A block of content inside a message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolCallId: string;
      output: unknown;
      isError: boolean;
    };

/** Session lifecycle: the Session has begun. */
export interface SessionStartedEvent extends NormalEventBase {
  kind: "session.started";
  /** The working directory the Coding agent ran in. */
  cwd: string;
  /** Set when this Session is a Subagent: the Session that spawned it. */
  parentSessionId?: string;
  /** Set when this Session is a Subagent: the Turn that spawned it. */
  spawnedByTurnId?: string;
}

/** Session lifecycle: the Session has ended. */
export interface SessionEndedEvent extends NormalEventBase {
  kind: "session.ended";
}

/** Turn: the user message that opened a Turn. */
export interface TurnStartedEvent extends NormalEventBase {
  kind: "turn.started";
  turnId: string;
  /** Set when the Turn branches off another Turn, forming a DAG. */
  parentTurnId?: string;
  /** The user message that opened the Turn. */
  prompt: string;
}

/** Turn: the full assistant response closed the Turn. */
export interface TurnEndedEvent extends NormalEventBase {
  kind: "turn.ended";
  turnId: string;
  /** The full assistant response for the Turn, tool-use loops included. */
  response: string;
}

/** Message: one role's message inside a Turn. */
export interface MessageEvent extends NormalEventBase {
  kind: "message";
  turnId: string;
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Tool event: a tool call the assistant made during a Turn. */
export interface ToolCallEvent extends NormalEventBase {
  kind: "tool.call";
  turnId: string;
  toolCallId: string;
  name: string;
  input: unknown;
}

/** Tool event: the result of a tool call made during a Turn. */
export interface ToolResultEvent extends NormalEventBase {
  kind: "tool.result";
  turnId: string;
  toolCallId: string;
  output: unknown;
  isError: boolean;
  /** How long the tool ran for, when the Listener could measure it. */
  durationMs?: number;
}

/** Model request: one HTTP call the agent made to a provider during a Turn. */
export interface ModelRequestEvent extends NormalEventBase {
  kind: "model.request";
  turnId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Round-trip latency of the call, when the Listener could measure it. */
  latencyMs?: number;
  /**
   * The cost of the call in US dollars, as the coding agent reported it. The
   * Server stores what the agent reports and does not normalize across
   * providers, so a Listener that cannot see a cost leaves this unset.
   */
  costUsd?: number;
}

/**
 * A normalized record a Listener ships to the Server. A discriminated union on
 * `kind`, so the Server can normalize without trusting an agent's own shape.
 */
export type NormalEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ModelRequestEvent;

/** The body of a batched ingestion request. */
export interface IngestRequest {
  events: NormalEvent[];
}

/** The body of a batched ingestion response. */
export interface IngestResponse {
  /** How many Events were newly persisted; replays report fewer than sent. */
  accepted: number;
}

/** A failed ingestion, carrying the Server's HTTP status. */
export class ShipEventsError extends Error {
  override readonly name = "ShipEventsError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`ship events failed (${status}): ${message}`);
  }
}

export interface ShipEventsOptions {
  /** The Server's base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** The Listener's bearer token, as minted for its User. */
  token: string;
  /** The Events to ship in one request. */
  events: NormalEvent[];
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Ship a batch of Events to the Server in one authenticated request. Throws a
 * {@link ShipEventsError} on any non-2xx response, so a rejected batch surfaces
 * loudly instead of the Listener silently dropping data.
 */
export async function sendEvents(
  options: ShipEventsOptions,
): Promise<IngestResponse> {
  const body: IngestRequest = { events: options.events };
  const response = await (options.fetch ?? fetch)(
    new URL("/api/events", options.baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw new ShipEventsError(response.status, await response.text());
  }

  return (await response.json()) as IngestResponse;
}
