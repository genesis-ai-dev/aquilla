/**
 * Client-side local store. Mirrors a subset of the D1 system of record;
 * see docs/DATA_PERSISTENCE_PLAN.md for the full architecture.
 *
 * Usage outline:
 *
 *   import { LocalStore, MIGRATIONS, ingestSnapshot, applyChangeBatch } from "@/lib/local-store"
 *
 *   const store = await LocalStore.open({ name: "codex-{projectId}" })
 *   await store.migrate(MIGRATIONS)
 *   await ingestSnapshot(store, fetchSnapshotLines(projectId))
 *   // …subscribe to DO websocket, call applyChangeBatch on each broadcast
 */

export { LocalStore, MigrationDriftError, type LocalStoreOptions } from "./db"
export { MIGRATIONS, type Migration } from "./migrations"

export {
  upsertCell,
  getCell,
  getCellsByScope,
  type CellRow,
} from "./cells"

export { searchCells, type SearchOptions } from "./search"

export {
  enqueueOutboxRecord,
  getOutboxRecord,
  listPending,
  markInFlight,
  markPending,
  markConflict,
  markFailed,
  deleteOutboxRecord,
  type OutboxRecord,
  type OutboxStatus,
  type NewOutboxRecord,
  type ListPendingOptions,
} from "./outbox"

export {
  upsertProjectMeta,
  getProjectMeta,
  getLastSeq,
  advanceLastSeq,
  type ProjectMetaRow,
} from "./project-meta"

export { ingestSnapshot, type SnapshotIngestResult } from "./snapshot"

export {
  applyChangeBatch,
  type ChangeBatch,
  type CommitRecord,
} from "./sync"

export { wipeOpfsDb } from "./wipe"

export {
  LocalStoreProvider,
  useProjectStore,
  useLocalStoreState,
  type LocalStoreState,
  type LocalStoreProviderProps,
} from "./provider"
