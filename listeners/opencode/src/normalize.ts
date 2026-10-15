/**
 * Normalization: turn the events OpenCode's plugin API delivers into the shared
 * `NormalEvent` shape. This is the whole reason a Listener exists, and it is the
 * only place that knows OpenCode's vocabulary.
 *
 * The plugin API, not OpenCode's on-disk storage, is the contract: the store is
 * mid-migration from JSON to SQLite, while the events below are what OpenCode
 * itself dispatches. OpenCode's schema has drifted before, so a handled event
 * whose payload no longer matches is reported loudly rather than dropped in
 * silence.
 */
import type { OpenCodeEvent } from "@opencode/client";
import type { NormalEvent, NormalEventBase } from "@slopwatch/events";
import { describeEvent, type Report } from "./report";

export interface NormalizerOptions {
  /** The running OpenCode version, used until a Session reports its own. */
  agentVersion: string;
  /** The working directory to fall back to, from the plugin's location. */
  directory: string;
  report: Report;
}

/** State the normalizer keeps to stitch OpenCode's events into Turns. */
interface SessionState {
  agentVersion: string;
  /** The latest user prompt, waiting for the Turn it opens to be identified. */
  pendingPrompt: string | null;
  /** The OpenCode assistant message id that is the current Turn's id. */
  turnId: string | null;
  /** Assistant text parts of the current Turn, keyed by ordinal. */
  response: Map<number, string>;
  /** The model each assistant message ran on, for its Model requests. */
  models: Map<string, { provider: string; model: string; startedAt: number }>;
  /** Tool call id to tool name, from the input-streaming event. */
  toolNames: Map<string, string>;
  /** Tool call id to when it started, for durations. */
  toolStartedAt: Map<string, number>;
  /**
   * Turn ids of `task` Tool calls, in call order. Each spawns one child Session,
   * which claims the oldest one when it announces itself.
   */
  spawnTurnIds: string[];
}

/** The fields every recorded OpenCode event carries. */
type RecordedEvent = {
  readonly id: string;
  readonly created: number;
  readonly type: string;
};

const AGENT = "opencode";

/**
 * The OpenCode Tool that spawns a Subagent. Its call runs inside the parent
 * Turn, so remembering that Turn as the call goes by is how a child Session
 * learns which Turn spawned it: `session.created` names only the parent.
 */
const SUBAGENT_TOOL = "task";

export class Normalizer {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly options: NormalizerOptions) {}

  /** Normalize one OpenCode event. Never throws: a bad event is reported. */
  handle(event: OpenCodeEvent): NormalEvent[] {
    try {
      return this.dispatch(event);
    } catch (error) {
      this.options.report(
        `failed to normalize OpenCode event ${describeEvent(event)}`,
        error,
      );
      return [];
    }
  }

  private dispatch(event: OpenCodeEvent): NormalEvent[] {
    switch (event.type) {
      case "session.created":
        return this.sessionCreated(event);
      case "session.deleted":
        return this.sessionEnded(event);
      case "session.inbox.enqueued":
        return this.inboxEnqueued(event);
      case "session.step.started":
        return this.stepStarted(event);
      case "session.step.ended":
        return this.stepEnded(event);
      case "session.step.failed":
        return this.stepFailed(event);
      case "session.text.ended":
        return this.textEnded(event);
      case "session.tool.input.started":
        return this.toolInputStarted(event);
      case "session.tool.called":
        return this.toolCalled(event);
      case "session.tool.success":
        return this.toolSucceeded(event);
      case "session.tool.failed":
        return this.toolFailed(event);
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return this.executionEnded(event);
      default:
        // OpenCode dispatches dozens of event types Slopwatch does not model
        // (tui, pty, shell, filesystem). Silence here is deliberate.
        return [];
    }
  }

  private sessionCreated(
    event: Extract<OpenCodeEvent, { type: "session.created" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];

    const version = nonBlank(event.data.version) ?? this.options.agentVersion;
    this.state(sessionId, version);
    const cwd =
      nonBlank(event.data.location?.directory) ??
      nonBlank(event.location?.directory) ??
      this.options.directory;

    // A Subagent announces only its parent Session. The Turn that spawned it
    // comes from the parent's `task` Tool call, if it has been seen.
    const parentSessionId = nonBlank(event.data.parentID);
    const spawnedByTurnId = parentSessionId
      ? this.takeSpawnTurn(parentSessionId)
      : undefined;

    return [
      {
        ...this.base(event, sessionId, "session.started"),
        kind: "session.started",
        cwd,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(spawnedByTurnId ? { spawnedByTurnId } : {}),
      },
    ];
  }

  private sessionEnded(
    event: Extract<OpenCodeEvent, { type: "session.deleted" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];

    return [
      {
        ...this.base(event, sessionId, "session.ended"),
        kind: "session.ended",
      },
    ];
  }

  /**
   * The user prompt. It opens a Turn, but OpenCode names the Turn by the
   * assistant message id, which is only known once the reply starts streaming,
   * so the prompt waits here for the first event that carries that id.
   */
  private inboxEnqueued(
    event: Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const item = event.data.item;
    if (item?.type !== "user") return [];

    this.state(sessionId, this.options.agentVersion).pendingPrompt =
      item.payload.text;
    return [];
  }

  private stepStarted(
    event: Extract<OpenCodeEvent, { type: "session.step.started" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, model, started } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    state.models.set(assistantMessageID, {
      provider: model.providerID,
      model: model.id,
      startedAt: started,
    });

    return this.ensureTurn(state, event, sessionId, assistantMessageID);
  }

  private stepEnded(
    event: Extract<OpenCodeEvent, { type: "session.step.ended" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, tokens, cost } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      this.modelRequest(
        state,
        event,
        sessionId,
        assistantMessageID,
        tokens,
        cost,
      ),
    ];
  }

  private stepFailed(
    event: Extract<OpenCodeEvent, { type: "session.step.failed" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, tokens, cost } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      this.modelRequest(
        state,
        event,
        sessionId,
        assistantMessageID,
        {
          input: tokens?.input ?? 0,
          output: tokens?.output ?? 0,
        },
        cost,
      ),
    ];
  }

  private textEnded(
    event: Extract<OpenCodeEvent, { type: "session.text.ended" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, ordinal, text } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    state.response.set(ordinal, text);
    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      {
        ...this.base(event, sessionId, "message"),
        kind: "message",
        turnId: assistantMessageID,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    ];
  }

  private toolInputStarted(
    event: Extract<OpenCodeEvent, { type: "session.tool.input.started" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    this.state(sessionId, this.options.agentVersion).toolNames.set(
      event.data.id,
      event.data.name,
    );
    return [];
  }

  private toolCalled(
    event: Extract<OpenCodeEvent, { type: "session.tool.called" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, id, input } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);
    // The name arrives on `session.tool.input.started`, before the call.
    const name = state.toolNames.get(id) ?? "unknown";

    // A `task` call runs inside this Turn and spawns one child Session, which
    // will claim this Turn when its `session.created` arrives.
    if (name === SUBAGENT_TOOL) state.spawnTurnIds.push(assistantMessageID);

    state.toolStartedAt.set(id, event.created);
    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      {
        ...this.base(event, sessionId, "tool.call"),
        kind: "tool.call",
        turnId: assistantMessageID,
        toolCallId: id,
        name,
        input,
      },
    ];
  }

  private toolSucceeded(
    event: Extract<OpenCodeEvent, { type: "session.tool.success" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, id, content } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      {
        ...this.base(event, sessionId, "tool.result"),
        kind: "tool.result",
        turnId: assistantMessageID,
        toolCallId: id,
        output: content,
        isError: false,
        ...this.duration(state, id, event.created),
      },
    ];
  }

  private toolFailed(
    event: Extract<OpenCodeEvent, { type: "session.tool.failed" }>,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const { assistantMessageID, id, error } = event.data;
    const state = this.state(sessionId, this.options.agentVersion);

    return [
      ...this.ensureTurn(state, event, sessionId, assistantMessageID),
      {
        ...this.base(event, sessionId, "tool.result"),
        kind: "tool.result",
        turnId: assistantMessageID,
        toolCallId: id,
        output: { error },
        isError: true,
        ...this.duration(state, id, event.created),
      },
    ];
  }

  /** A Turn ends when OpenCode finishes the execution the prompt kicked off. */
  private executionEnded(
    event: Extract<
      OpenCodeEvent,
      {
        type:
          | "session.execution.succeeded"
          | "session.execution.failed"
          | "session.execution.interrupted";
      }
    >,
  ): NormalEvent[] {
    const sessionId = this.requireSessionId(event);
    if (!sessionId) return [];
    const state = this.sessions.get(sessionId);
    const turnId = state?.turnId;
    if (!state || !turnId) return [];

    const response = [...state.response.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join("\n");

    state.turnId = null;
    state.pendingPrompt = null;
    state.response = new Map();
    state.models.delete(turnId);

    return [
      {
        ...this.base(event, sessionId, "turn.ended"),
        kind: "turn.ended",
        turnId,
        response,
      },
    ];
  }

  /**
   * Open a Turn the first time an event names its assistant message id. The
   * Turn id is that message id: it is the stable key every Tool event and Model
   * request in the Turn carries.
   *
   * The user prompt rides on `turn.started` rather than its own `message`
   * Event: OpenCode identifies the Turn only once the assistant reply starts,
   * so the prompt recorded at `session.inbox.enqueued` is attached here.
   */
  private ensureTurn(
    state: SessionState,
    event: RecordedEvent,
    sessionId: string,
    assistantMessageId: string,
  ): NormalEvent[] {
    if (state.turnId === assistantMessageId) return [];

    state.turnId = assistantMessageId;
    state.response = new Map();
    const prompt = state.pendingPrompt ?? "";
    state.pendingPrompt = null;

    return [
      {
        ...this.base(event, sessionId, "turn.started"),
        kind: "turn.started",
        turnId: assistantMessageId,
        prompt,
      },
    ];
  }

  private modelRequest(
    state: SessionState,
    event: RecordedEvent,
    sessionId: string,
    assistantMessageId: string,
    tokens: { input: number; output: number },
    costUsd?: number,
  ): NormalEvent {
    const model = state.models.get(assistantMessageId);
    if (!model) {
      this.options.report(
        `Model request for ${assistantMessageId} has no matching step; shipping it without a provider`,
      );
    }

    return {
      ...this.base(event, sessionId, "model.request"),
      kind: "model.request",
      turnId: assistantMessageId,
      provider: model?.provider ?? "unknown",
      model: model?.model ?? "unknown",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      ...(model && model.startedAt > 0
        ? { latencyMs: Math.max(0, event.created - model.startedAt) }
        : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  private duration(
    state: SessionState,
    toolCallId: string,
    endedAt: number,
  ): { durationMs?: number } {
    const startedAt = state.toolStartedAt.get(toolCallId);
    state.toolStartedAt.delete(toolCallId);
    if (startedAt === undefined) return {};
    return { durationMs: Math.max(0, endedAt - startedAt) };
  }

  /**
   * The Turn that spawned a Subagent, claimed from the parent Session's queue of
   * `task` Tool calls. Omitted when the parent's call has not been seen, so an
   * unlinked child is preferred to a wrongly linked one.
   */
  private takeSpawnTurn(parentSessionId: string): string | undefined {
    return this.sessions.get(parentSessionId)?.spawnTurnIds.shift();
  }

  private requireSessionId(event: {
    type: string;
    data?: { sessionID?: unknown };
  }): string | null {
    const id = event.data?.sessionID;
    if (typeof id !== "string" || id.length === 0) {
      this.options.report(
        `OpenCode event ${describeEvent(event)} has no session id; skipping it`,
      );
      return null;
    }
    return id;
  }

  private state(sessionId: string, agentVersion: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        agentVersion,
        pendingPrompt: null,
        turnId: null,
        response: new Map(),
        models: new Map(),
        toolNames: new Map(),
        toolStartedAt: new Map(),
        spawnTurnIds: [],
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private base(
    event: RecordedEvent,
    sessionId: string,
    kind: string,
  ): NormalEventBase {
    return {
      // `event.id` is unique per OpenCode event; the suffix keeps the two
      // Events one delivery can produce (e.g. turn.started + model.request)
      // distinct, so ingestion dedupes retries without merging them.
      id: `${event.id}:${kind}`,
      sessionId,
      agent: AGENT,
      agentVersion:
        this.sessions.get(sessionId)?.agentVersion ?? this.options.agentVersion,
      occurredAt: new Date(event.created).toISOString(),
      raw: event,
    };
  }
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
