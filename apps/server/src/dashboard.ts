import type { SessionDetail, SessionSummary } from "./db";

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

/** The dashboard's Session detail: one Session's Turns, prompt and response. */
export function renderSessionDetail(session: SessionDetail): string {
  const turns = session.turns
    .map(
      (turn) => `
      <article class="turn">
        <h3><code>${escapeHtml(turn.id)}</code></h3>
        <h4>Prompt</h4>
        <pre class="prompt">${escapeHtml(turn.prompt ?? "")}</pre>
        <h4>Response</h4>
        <pre class="response">${escapeHtml(turn.response ?? "")}</pre>
      </article>`,
    )
    .join("");

  const body = `
    <p><a href="/">&larr; All Sessions</a></p>
    <h1><code>${escapeHtml(session.id)}</code></h1>
    <dl>
      <dt>User</dt><dd>${escapeHtml(session.user.name)} &lt;${escapeHtml(session.user.email)}&gt;</dd>
      <dt>Coding agent</dt><dd>${escapeHtml(session.agent)} ${escapeHtml(session.agentVersion)}</dd>
      <dt>cwd</dt><dd><code>${escapeHtml(session.cwd ?? "")}</code></dd>
      <dt>Started</dt><dd>${escapeHtml(session.startedAt ?? "")}</dd>
      <dt>Ended</dt><dd>${escapeHtml(session.endedAt ?? "still active")}</dd>
    </dl>
    <h2>Turns</h2>
    ${turns || `<p class="empty">No Turns yet.</p>`}`;

  return page(escapeHtml(session.id), body);
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
