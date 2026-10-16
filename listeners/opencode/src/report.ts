/**
 * How the Listener reports problems.
 *
 * It shares a runtime with the coding agent, so it never throws into the host:
 * every failure goes through a `Report`, which logs by default and is captured
 * by tests.
 */
export type Report = (message: string, details?: unknown) => void;

/** The default `Report`: a prefixed line on stderr. */
export function consoleReport(message: string, details?: unknown): void {
  if (details === undefined) {
    console.error(`[slopwatch] ${message}`);
  } else {
    console.error(`[slopwatch] ${message}`, details);
  }
}

/** An OpenCode event's `type`, for a report message, or `"unknown"`. */
export function describeEvent(event: unknown): string {
  if (typeof event === "object" && event !== null) {
    const type = (event as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}

/** Format a count of Events for a report, e.g. `1 Event` or `3 Events`. */
export function eventCount(count: number): string {
  return `${count} ${count === 1 ? "Event" : "Events"}`;
}
