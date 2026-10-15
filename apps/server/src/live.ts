/**
 * The live-spectate view: a Session's Events appended by polling the
 * incremental endpoint every ~5s and on tab focus. It is progressive
 * enhancement over the server-rendered Turn tree, so that tree stays the
 * complete record when JavaScript is unavailable.
 */
import { escapeHtml } from "./html";

/** How often the live view polls, in milliseconds. ~5s, per the architecture. */
const LIVE_POLL_MS = 5_000;

/**
 * The live Events region and the poller that feeds it. The element carries the
 * session id, the sequence to resume from, and the poll interval as data
 * attributes, so the one contract lives in the markup and the script reads it.
 *
 * `sinceSeq` is the Session's sequence at page load: the Turn tree above already
 * shows everything up to it, so the view appends only what happens next rather
 * than refetching the Session.
 */
export function renderLiveEvents(sessionId: string, sinceSeq: number): string {
  return `
    <h2>Live Events</h2>
    <p class="muted">Appends as the Session is written; every ~5s, and when this tab regains focus.</p>
    <noscript><p class="empty">Live Events need JavaScript. The Turn tree above is the full record.</p></noscript>
    <ol id="live-events" class="events" data-session-id="${escapeHtml(sessionId)}" data-since-seq="${sinceSeq}" data-poll-ms="${LIVE_POLL_MS}"></ol>
    <script>${LIVE_EVENTS_SCRIPT}</script>`;
}

/**
 * The polling client, inlined into the page. It fetches only Events newer than
 * the last one it has seen, appends them, and never refetches the Session. It
 * swallows its own errors so a Server blip leaves the view intact rather than
 * breaking the page.
 */
const LIVE_EVENTS_SCRIPT = `(function () {
  var feed = document.getElementById("live-events");
  if (!feed) return;
  var sessionId = feed.getAttribute("data-session-id");
  var pollMs = Number(feed.getAttribute("data-poll-ms")) || ${LIVE_POLL_MS};
  var sinceSeq = Number(feed.getAttribute("data-since-seq")) || 0;

  function summary(event) {
    switch (event.kind) {
      case "session.started": return event.cwd;
      case "session.ended": return "";
      case "turn.started": return event.prompt;
      case "turn.ended": return event.response;
      case "model.request": return event.provider + " " + event.model;
      case "tool.call": return event.name;
      case "tool.result": return event.isError ? "failed: " + event.toolCallId : "ok: " + event.toolCallId;
      case "message": return event.role;
      default: return "";
    }
  }

  function span(className, text) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text == null ? "" : String(text);
    return node;
  }

  function append(stored) {
    var item = document.createElement("li");
    item.className = "event";
    item.setAttribute("data-seq", String(stored.seq));
    item.appendChild(span("seq", "#" + stored.seq));
    item.appendChild(span("kind", stored.event.kind));
    item.appendChild(span("muted", stored.event.occurredAt));
    item.appendChild(span("summary", summary(stored.event)));
    feed.appendChild(item);
  }

  var inFlight = false;
  function refresh() {
    if (inFlight) return;
    inFlight = true;
    fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/events?since_seq=" + sinceSeq)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (!body) return;
        body.events.forEach(function (stored) {
          if (stored.seq <= sinceSeq) return;
          append(stored);
          sinceSeq = stored.seq;
        });
      })
      .catch(function () {})
      .then(function () { inFlight = false; });
  }

  setInterval(refresh, pollMs);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refresh();
  });
  refresh();
})();`;
