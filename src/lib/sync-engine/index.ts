/**
 * Network-side of the new sync stack. See docs/DATA_PERSISTENCE_PLAN.md §8.
 *
 * Three operations:
 *   - loadSnapshot(store, deps)   initial bulk load on first project open
 *   - fetchChanges(store, deps)   incremental catchup since last_seq
 *   - flushOutbox(store, deps)    drain pending mutations to the server
 *
 * Live presence + change broadcast + Y.Text relay arrive via the project
 * Durable Object websocket — see (forthcoming) live-sync module.
 */

export { loadSnapshot, type SnapshotLoaderDeps } from "./load-snapshot"
export {
  fetchChanges,
  type ChangesFetchDeps,
  type ChangesFetchResult,
} from "./fetch-changes"
export {
  flushOutbox,
  type FlushDeps,
  type FlushResult,
} from "./flush"
