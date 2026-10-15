/**
 * `@slopwatch/listener-opencode`: the OpenCode Listener.
 *
 * The default export is the OpenCode plugin, so listing this package in
 * `opencode.json`'s `plugins` is enough to capture Sessions. `createListener`
 * and `setupListener` are the capture surfaces the tests drive directly.
 */
export { createListener } from "./listener";
export type { Listener, ListenerOptions } from "./listener";
export {
  setupListener,
  startListener,
  type ListenerConfig,
  type ListenerContext,
  type ListenerDeps,
  type RunningListener,
  type StartedListener,
} from "./plugin";
export type { Report } from "./report";
export { default } from "./plugin";
