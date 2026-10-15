/**
 * Recorded OpenCode plugin events for one Session: a user prompt, one model
 * step with a tool call, the assistant's reply, and the Session ending.
 *
 * They are typed against `@opencode/client`'s event schema (OpenCode 2.0.26), so
 * a shape drift in the schema breaks this file at compile time rather than
 * silently breaking capture.
 */
import type {
  OpenCodeEvent,
  SessionCreated,
  SessionDeleted,
  SessionExecutionStarted,
  SessionExecutionSucceeded,
  SessionInboxEnqueued,
  SessionStepEnded,
  SessionStepStarted,
  SessionTextEnded,
  SessionToolCalled,
  SessionToolInputStarted,
  SessionToolSuccess,
} from "@opencode/client";

/** The Session the recorded events describe. */
export const SESSION_ID = "ses_recorded";
/** The assistant message id, which Slopwatch uses as the Turn id. */
export const TURN_ID = "msg_assistant_1";
/** The prompt the developer typed. */
export const PROMPT = "rename the user table";
/** The assistant's reply. */
export const RESPONSE = "Renamed the table and updated the migration.";

const BASE = Date.parse("2026-10-15T10:00:00.000Z");
const at = (seconds: number): number => BASE + seconds * 1_000;
const durable = <Version extends 1 | 2>(seq: number, version: Version) => ({
  aggregateID: SESSION_ID,
  seq,
  version,
});

const created: SessionCreated = {
  id: "evt_1",
  created: at(0),
  type: "session.created",
  durable: durable(1, 1),
  location: { directory: "/home/dev/project" },
  data: {
    sessionID: SESSION_ID,
    projectID: "prj_1",
    location: { directory: "/home/dev/project" },
    slug: "rename-user-table",
    version: "2.0.26",
  },
};

const prompt: SessionInboxEnqueued = {
  id: "evt_2",
  created: at(1),
  type: "session.inbox.enqueued",
  durable: durable(2, 1),
  data: {
    sessionID: SESSION_ID,
    inboxID: "inbox_1",
    item: {
      type: "user",
      delivery: "steer",
      payload: { text: PROMPT },
    },
  },
};

const executionStarted: SessionExecutionStarted = {
  id: "evt_3",
  created: at(2),
  type: "session.execution.started",
  durable: durable(3, 1),
  data: { sessionID: SESSION_ID },
};

const stepStarted: SessionStepStarted = {
  id: "evt_4",
  created: at(3),
  type: "session.step.started",
  durable: durable(4, 1),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    started: at(3),
  },
};

const toolInputStarted: SessionToolInputStarted = {
  id: "evt_5",
  created: at(4),
  type: "session.tool.input.started",
  durable: durable(5, 1),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    id: "call_1",
    name: "bash",
  },
};

const toolCalled: SessionToolCalled = {
  id: "evt_6",
  created: at(5),
  type: "session.tool.called",
  durable: durable(6, 1),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    id: "call_1",
    input: { command: "rg 'user' migrations" },
    executed: true,
  },
};

const toolSucceeded: SessionToolSuccess = {
  id: "evt_7",
  created: at(6),
  type: "session.tool.success",
  durable: durable(7, 2),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    id: "call_1",
    content: [{ type: "text", text: "migrations/0007_users.sql" }],
    executed: true,
  },
};

const textEnded: SessionTextEnded = {
  id: "evt_8",
  created: at(7),
  type: "session.text.ended",
  durable: durable(8, 1),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    ordinal: 0,
    text: RESPONSE,
  },
};

const stepEnded: SessionStepEnded = {
  id: "evt_9",
  created: at(8),
  type: "session.step.ended",
  durable: durable(9, 1),
  data: {
    sessionID: SESSION_ID,
    assistantMessageID: TURN_ID,
    finish: "tool-calls",
    cost: 0.02,
    tokens: {
      input: 1_200,
      output: 80,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  },
};

const executionSucceeded: SessionExecutionSucceeded = {
  id: "evt_10",
  created: at(9),
  type: "session.execution.succeeded",
  durable: durable(10, 1),
  data: { sessionID: SESSION_ID },
};

const deleted: SessionDeleted = {
  id: "evt_11",
  created: at(10),
  type: "session.deleted",
  durable: durable(11, 2),
  data: { sessionID: SESSION_ID },
};

/** One Session's worth of OpenCode plugin events, in dispatch order. */
export const recordedSession: OpenCodeEvent[] = [
  created,
  prompt,
  executionStarted,
  stepStarted,
  toolInputStarted,
  toolCalled,
  toolSucceeded,
  textEnded,
  stepEnded,
  executionSucceeded,
  deleted,
];

/**
 * A `session.created` whose payload no longer carries `data.sessionID`: the
 * shape OpenCode would hand a Listener after a schema drift. Cast because the
 * whole point is that it no longer matches the declared type.
 */
export const driftedEvent = {
  id: "evt_drift",
  created: at(11),
  type: "session.created",
  durable: durable(12, 1),
  data: {
    projectID: "prj_1",
    location: { directory: "/home/dev/project" },
    slug: "drifted",
    version: "2.0.26",
  },
} as unknown as OpenCodeEvent;
