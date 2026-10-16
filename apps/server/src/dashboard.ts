import type { SessionDetail, SessionSummary, Turn, User } from "./db";
import { escapeHtml } from "./html";
import { renderLiveEvents } from "./live";
import type { AgentSpend, LeaderboardRow } from "./rollups";

/** The dashboard's Sessions index: every Session, newest first. */
export function renderSessionList(sessions: SessionSummary[]): string {
  const body =
    sessions.length === 0
      ? `<p class="empty">No Sessions yet.</p>`
      : sessionTable(sessions);

  return page("Sessions", `<h1>Sessions</h1>${body}`);
}

/** A table of Sessions, linked by id and naming their owner and coding agent. */
function sessionTable(sessions: SessionSummary[]): string {
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

  return `<table>
        <thead>
          <tr><th>Session</th><th>User</th><th>Coding agent</th><th>cwd</th><th>Status</th><th>Turns</th><th>Started</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
}

/**
 * The dashboard's search page: a search box, then matching Sessions and matching
 * Users each under their own heading with a result count. An empty query shows
 * the box alone; a query with no matches shows each category as empty rather
 * than as an error.
 */
export function renderSearch(
  query: string,
  sessions: SessionSummary[],
  users: User[],
): string {
  const body = query
    ? `
    <h2>Sessions <span class="count">${sessions.length}</span></h2>
    ${sessions.length ? sessionTable(sessions) : `<p class="empty">No matching Sessions.</p>`}
    <h2>Users <span class="count">${users.length}</span></h2>
    ${users.length ? userTable(users) : `<p class="empty">No matching Users.</p>`}`
    : `<p class="empty">Search Sessions by id, cwd, or coding agent, and Users by name or email.</p>`;

  return page("Search", `<h1>Search</h1>${searchForm(query)}${body}`);
}

/** One User's page: their identity, then the Sessions they own. */
export function renderUser(user: User, sessions: SessionSummary[]): string {
  const body = `
    <p><a href="/">&larr; All Sessions</a></p>
    <h1>${escapeHtml(user.name)}</h1>
    <p class="muted">${escapeHtml(user.email)}</p>
    <h2>Sessions <span class="count">${sessions.length}</span></h2>
    ${sessions.length ? sessionTable(sessions) : `<p class="empty">No Sessions from this User.</p>`}`;

  return page(escapeHtml(user.name), body);
}

/** The search box, echoing the query the caller is looking at. */
function searchForm(query: string): string {
  return `
    <form class="search" action="/search" method="get">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search Sessions and Users" />
      <button type="submit">Search</button>
    </form>`;
}

/** A table of Users, linked by id and naming their identity. */
function userTable(users: User[]): string {
  const rows = users
    .map(
      (user) => `
      <tr>
        <td><a href="/users/${escapeHtml(user.id)}">${escapeHtml(user.name)}</a></td>
        <td class="muted">${escapeHtml(user.email)}</td>
      </tr>`,
    )
    .join("");

  return `<table class="users">
        <thead>
          <tr><th>User</th><th>Email</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
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
    ${renderLiveEvents(session.id, session.eventSeq)}
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
 * The Developer leaderboard: one row per User, ranked by the day's spend
 * descending, each with its counts, top coding agent, 7-day delta, and an
 * hourly sparkline. `date` names the day the ranking is scoped to.
 */
export function renderLeaderboard(
  rows: LeaderboardRow[],
  date: string,
): string {
  const topSpend = Math.max(0, ...rows.map((row) => row.spendUsd ?? 0));
  const tableRows = rows
    .map((row, index) => {
      return `
      <tr>
        <td class="rank">${String(index + 1).padStart(2, "0")}</td>
        <td><a href="/users/${escapeHtml(row.user.id)}">${escapeHtml(row.user.name)}</a><span class="muted"> · ${escapeHtml(row.user.email)}</span></td>
        <td class="num">${formatUsd(row.spendUsd)}</td>
        ${renderShare(row.spendUsd, topSpend)}
        <td class="num">${row.sessionCount}</td>
        <td class="num">${row.turnCount}</td>
        <td class="num">${row.requestCount}</td>
        <td>${row.topAgent === null ? '<span class="muted">none</span>' : `<span class="chip">${escapeHtml(row.topAgent)}</span>`}</td>
        <td class="num ${deltaClass(row.delta7d)}">${formatDelta(row.delta7d)}</td>
        <td>${renderSparkline(row.hourlySpend)}</td>
      </tr>`;
    })
    .join("");

  const body =
    rows.length === 0
      ? emptySpend(date)
      : `<table class="leaderboard">
        <thead>
          <tr>
            <th>#</th><th>Developer</th><th>Spend</th><th>Share</th>
            <th>Sessions</th><th>Turns</th><th>Requests</th>
            <th>Top coding agent</th><th>7d Δ</th><th>Today</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;

  return page(
    "Leaderboard",
    `<h1>Leaderboard</h1><p class="muted">Ranked by spend on ${escapeHtml(date)}.</p>${body}`,
  );
}

/** The org-level spend-per-coding-agent breakdown for one day. */
export function renderSpendByAgent(agents: AgentSpend[], date: string): string {
  const total = agents.reduce((sum, agent) => sum + (agent.spendUsd ?? 0), 0);
  const tableRows = agents
    .map((agent) => {
      const share = percentOf(agent.spendUsd, total);
      return `
      <tr>
        <td><span class="chip">${escapeHtml(agent.agent)}</span></td>
        <td class="num">${formatUsd(agent.spendUsd)}</td>
        ${renderShare(agent.spendUsd, total)}
        <td class="num">${share}%</td>
        <td class="num">${agent.requestCount}</td>
      </tr>`;
    })
    .join("");

  const body =
    agents.length === 0
      ? emptySpend(date)
      : `<table class="agents">
        <thead>
          <tr><th>Coding agent</th><th>Spend</th><th>Share</th><th>%</th><th>Model requests</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;

  return page(
    "Spend by coding agent",
    `<h1>Spend by coding agent</h1><p class="muted">Org spend on ${escapeHtml(date)}.</p>${body}`,
  );
}

/** A share bar, normalized to `max`, so the top row is always a full bar. */
function renderShare(spendUsd: number | null, max: number): string {
  const share = percentOf(spendUsd, max);
  return `<td class="share"><span class="bar" style="width:${share}%"></span></td>`;
}

/** `spend` as a whole-number percentage of `max`, or 0 when `max` is unknown. */
function percentOf(spend: number | null, max: number): number {
  if (max <= 0) return 0;
  return Math.round(((spend ?? 0) / max) * 100);
}

function emptySpend(date: string): string {
  return `<p class="empty">No spend on ${escapeHtml(date)}.</p>`;
}

/** A signed percentage for the 7-day delta, or `unknown`. */
function formatDelta(delta: number | null): string {
  if (delta === null) return "unknown";
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1)}%`;
}

function deltaClass(delta: number | null): string {
  if (delta === null) return "muted";
  return delta >= 0 ? "up" : "down";
}

/**
 * A 24-point hourly spend sparkline. Bars are scaled to the day's peak; an hour
 * whose spend is unknown renders as a muted, full-width marker rather than a
 * zero, so unknown is never drawn as free.
 */
function renderSparkline(points: (number | null)[]): string {
  const slot = 5;
  const bar = 4;
  const height = 24;
  const max = Math.max(0, ...points.map((point) => point ?? 0));
  const bars = points
    .map((point, hour) => {
      const x = hour * slot;
      if (point === null) {
        return `<rect class="unknown" x="${x}" y="0" width="${bar}" height="${height}" />`;
      }
      const barHeight = max > 0 ? Math.round((point / max) * height) : 0;
      return `<rect x="${x}" y="${height - barHeight}" width="${bar}" height="${barHeight}" />`;
    })
    .join("");
  const width = points.length * slot - (slot - bar);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="hourly spend"><title>Hourly spend</title>${bars}</svg>`;
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
      ol.events { list-style: none; margin: 0; padding: 0; }
      ol.events li.event { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.25rem 0; border-bottom: 1px solid #8884; }
      ol.events .seq { font-variant-numeric: tabular-nums; opacity: 0.6; min-width: 3rem; }
      ol.events .kind { font-family: ui-monospace, monospace; }
      ol.events .summary { overflow-wrap: anywhere; }
      h4 { margin: 0.6rem 0 0.3rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
      nav.site { display: flex; gap: 1rem; margin-bottom: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #8884; }
      nav.site a { text-decoration: none; }
      th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; opacity: 0.7; }
      .rank { font-variant-numeric: tabular-nums; opacity: 0.7; }
      .chip { font-family: ui-monospace, monospace; background: #8881; border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.85em; }
      .share { width: 8rem; }
      .share .bar { display: block; height: 0.6rem; background: currentColor; opacity: 0.5; border-radius: 2px; }
      .up { color: #1a7f37; }
      .down { color: #cf222e; }
      svg.spark { display: block; }
      svg.spark rect { fill: currentColor; opacity: 0.7; }
      svg.spark rect.unknown { opacity: 0.15; }
      form.search { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
      form.search input { flex: 1; font: inherit; padding: 0.35rem 0.6rem; }
      .count { font-variant-numeric: tabular-nums; opacity: 0.6; font-weight: normal; }
    </style>
  </head>
  <body>
    <nav class="site"><a href="/">Sessions</a><a href="/leaderboard">Leaderboard</a><a href="/spend-by-agent">Spend by coding agent</a><a href="/search">Search</a></nav>
    ${body}
  </body>
</html>
`;
}
