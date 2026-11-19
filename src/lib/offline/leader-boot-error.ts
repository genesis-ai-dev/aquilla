// The offline store's leader worker stopped before the store opened (its
// OPFS files stayed busy, its boot crashed, ...). Named so the boot-failure
// log and tests can tell it from LiveStore's own boot errors; in a module of
// its own so nothing that only wants the type imports store.ts, which would
// pull LiveStore into every browser visit (AQU-2091).

export class OfflineLeaderBootError extends Error {
  override name = "OfflineLeaderBootError"
}
