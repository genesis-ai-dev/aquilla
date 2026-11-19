// The offline store's leader worker stopped before the store opened (its
// OPFS files stayed busy, its boot crashed, ...). In a module of its own so
// OfflineLeaderWatchdog can recognise it without importing store.ts, which
// would pull LiveStore into every browser visit (AQU-2091).

export class OfflineLeaderBootError extends Error {
  override name = "OfflineLeaderBootError"
}
