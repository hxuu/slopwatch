/**
 * OpenCode's v2 plugin loader resolves a configured plugin *directory* to its
 * `server` entrypoint, so a directory that only exposes `exports["."]` is
 * rejected. This re-export makes the package loadable both by path and (with a
 * matching `"./server"` export) by name.
 */
export { default } from "./src/index.ts";
