import type { SessionDetail, SessionSummary, Turn } from "./db";

/** The dashboard's Sessions index: every Session, newest first. */
export function renderSessionList(sessions: SessionSummary[]): string {
  const rows = sessions
    .map(
      (session) => `
      <tr>
        <td><a href="/sessions/${escapeHtml(session.id)}"><code>${escapeHtml(session.id)}</code></a></td>
        <td>${escapeHtml(session.user.name)}</td>
        <td>${escapeHtml(session.agent)} <span class="muted">${escapeHtml(session.agentVersion)}</span></td>
        <td><code>${escapeHtml(session.cwd ?? "")}</code></td>
        <td>${session.endedAt ? '<span class="ended">ended</span>' : '<span class="active">active</span>'}</td>
        <td class="num">${session.turnCount}</td>
        <td class="muted">${escapeHtml(session.startedAt ?? "")}</td>
      </tr>`,
    )
    .join("");

  const body =
    sessions.length === 0
      ? `<p class="empty">No Sessions yet.</p>`
      : `<table>
        <thead>
          <tr><th>Session</th><th>User</th><th>Coding agent</th><th>cwd</th><th>Status</th><th>Turns</th><th>Started</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

  return page("Sessions", `<h1>Sessions</h1>${body}`);
}

/** The dashboard's Session detail: one Session's Turns as a tree, prompt and response. */
export function renderSessionDetail(session: SessionDetail): string {
  const turns = session.turns.length
    ? renderTurnForest(session.turns)
    : `<p class="empty">No Turns yet.</p>`;

  const body = `
    <p><a href="/">&larr; All Sessions</a></p>
    <h1><code>${escapeHtml(session.id)}</code></h1>
    <dl>
      <dt>User</dt><dd>${escapeHtml(session.user.name)} &lt;${escapeHtml(session.user.email)}&gt;</dd>
      <dt>Coding agent</dt><dd>${escapeHtml(session.agent)} ${escapeHtml(session.agentVersion)}</dd>
      <dt>cwd</dt><dd><code>${escapeHtml(session.cwd ?? "")}</code></dd>
      <dt>Started</dt><dd>${escapeHtml(session.startedAt ?? "")}</dd>
      <dt>Ended</dt><dd>${escapeHtml(session.endedAt ?? "still active")}</dd>
      ${renderSpawnLink(session)}
    </dl>
    <h2>Turns</h2>
    ${turns}
    <h2>Subagents</h2>
    ${renderSubagents(session.childSessions)}`;

  return page(escapeHtml(session.id), body);
}

/**
 * When this Session is itself a Subagent, its parent Session and the Turn it was
 * spawned by, as links back.
 */
function renderSpawnLink(session: SessionDetail): string {
  if (!session.parentSessionId) return "";
  const spawnedBy = session.spawnedByTurnId
    ? `<code>${escapeHtml(session.spawnedByTurnId)}</code>`
    : "an unknown Turn";
  return `<dt>Subagent of</dt><dd><a href="/sessions/${escapeHtml(session.parentSessionId)}"><code>${escapeHtml(session.parentSessionId)}</code></a>, spawned by ${spawnedBy}</dd>`;
}

/** The child Sessions this Session spawned, each linked and costed its own. */
function renderSubagents(childSessions: SessionSummary[]): string {
  if (childSessions.length === 0) {
    return `<p class="empty">No Subagents.</p>`;
  }
  const items = childSessions
    .map(
      (child) => `
      <li class="subagent">
        <a href="/sessions/${escapeHtml(child.id)}"><code>${escapeHtml(child.id)}</code></a>
        <span class="muted">${escapeHtml(child.agent)}</span>
        <span class="num">${child.turnCount} Turns</span>
        <span class="num">${formatUsd(child.costUsd)}</span>
      </li>`,
    )
    .join("");
  return `<ul class="subagents">${items}</ul>`;
}

/** A cost as dollars, or `unknown` when no Model request reported one. */
function formatUsd(costUsd: number | null): string {
  return costUsd === null ? "unknown" : `$${costUsd.toFixed(4)}`;
}

/**
 * Render a Session's Turns as a tree. Turns arrive in Session order, each naming
 * its parent, so the View rebuilds the DAG the Listener shipped rather than
 * flattening it; a linear Session falls out as a straight chain for free.
 */
function renderTurnForest(turns: Turn[]): string {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const children = new Map<string | null, Turn[]>();
  for (const turn of turns) {
    const parent = parentOf(turn, byId);
    const siblings = children.get(parent) ?? [];
    siblings.push(turn);
    children.set(parent, siblings);
  }

  function renderList(list: Turn[]): string {
    return `<ol class="turns">${list.map(renderNode).join("")}</ol>`;
  }

  function renderNode(turn: Turn): string {
    const nested = children.get(turn.id) ?? [];
    return `
      <li class="turn" data-turn-id="${escapeHtml(turn.id)}" data-parent-turn-id="${escapeHtml(turn.parentTurnId ?? "")}">
        <h3><code>${escapeHtml(turn.id)}</code></h3>
        <h4>Prompt</h4>
        <pre class="prompt">${escapeHtml(turn.prompt ?? "")}</pre>
        <h4>Response</h4>
        <pre class="response">${escapeHtml(turn.response ?? "")}</pre>
        ${nested.length ? renderList(nested) : ""}
      </li>`;
  }

  return renderList(children.get(null) ?? []);
}

/**
 * The parent Turn a Turn nests under, or null when it is a root. A reference to
 * a Turn outside this Session is a root rather than a dropped Turn.
 */
function parentOf(turn: Turn, byId: Map<string, Turn>): string | null {
  const parent = turn.parentTurnId;
  if (!parent || parent === turn.id || !byId.has(parent)) return null;
  return parent;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Slopwatch</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #8884; }
      code, pre { font-family: ui-monospace, monospace; }
      pre { white-space: pre-wrap; background: #8881; padding: 0.6rem 0.8rem; border-radius: 6px; margin: 0 0 1rem; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { opacity: 0.6; }
      .active { color: #1a7f37; }
      .ended { color: #8250df; }
      .turn { border: 1px solid #8884; border-radius: 8px; padding: 0.5rem 1rem 1rem; margin-bottom: 1rem; }
      ol.turns { list-style: none; margin: 0; padding-left: 0; }
      ol.turns ol.turns { margin-top: 0.75rem; padding-left: 1rem; border-left: 2px solid #8884; }
      ul.subagents { list-style: none; margin: 0; padding: 0; }
      ul.subagents li { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.35rem 0; border-bottom: 1px solid #8884; }
      ul.subagents .num { margin-left: auto; }
      h4 { margin: 0.6rem 0 0.3rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
    </style>
  </head>
  <body>${body}</body>
</html>
`;
}

/** Escape text for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
