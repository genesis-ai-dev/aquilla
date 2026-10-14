// The Aquilla database handle: Postgres (Neon), presented through a small
// statement/batch API that the workers' ~80 routes use as `env.AQUILLA_PG`.
//
// Routes speak a compact SQL surface (`prepare().bind().run()/all()/first()`,
// `batch()`, `exec()`); this module implements that surface (`AquillaDb`)
// directly over Postgres, so a route never touches a raw driver.
//
// Executor-agnostic: prod uses postgres.js over Hyperdrive (`makePostgres`),
// tests use PGlite (real Postgres in WASM) via a `PgExecutor` adapter — so
// tests exercise the exact same code + real dialect.
//
// Two dialect details handled here:
//   1. placeholders — `?` → Postgres `$1,$2,…`  (translated below)
//   2. return types — BIGINT/NUMERIC come back as JS numbers and
//      TIMESTAMP/TIMESTAMPTZ as strings (the postgres.js executor overrides
//      parsers), so callers get numbers and ISO-ish strings, not bigints.
//
// NOT handled here (fixed in the SQL itself): `INSERT OR IGNORE` →
// `ON CONFLICT DO NOTHING`, FTS `MATCH` → `@@ tsquery`, etc.
//
// Caveat: `?`→`$n` is textual; it assumes `?` appears only as a placeholder
// (true for this codebase — string literals use single quotes).
//
// RLS / identity threading (AQU-289)
// ------------------------------------
// In production, workers connect as the `app_runtime` Postgres role (see
// db/postgres/migrations/0034_rls_backstop.sql).  RLS policies on the
// project-scoped tables read `current_setting('app.user_id', true)` to
// determine which rows are visible.
//
// Two entry points control identity:
//
//   db.withUser(userId)  — returns a new PostgresDb whose every query
//     wraps in a transaction with `SET LOCAL app.user_id = '<userId>'`.
//     Use for every authenticated request.
//
//   db.asAdmin()  — returns a new PostgresDb that runs with
//     `SET LOCAL app.user_id = ''`, bypassing identity-gated RLS.
//     For identity-less code paths (migration helpers, rebuild,
//     diarization callback, admin routes that already run as the owner
//     role on Neon).  Must be called explicitly; never used implicitly.
//
// Implementation note: `SET LOCAL` is transaction-scoped.  Because routes
// mostly use individual prepare().bind().run() calls (not batch()), every
// query execution wraps in a mini-transaction to make SET LOCAL effective.
// This is correct with Hyperdrive connection pooling: the SET LOCAL is
// never visible to a different request's connection.

// Connection timeouts (AQU-1876)
// ---------------------------------
// Every handle built by makePostgres() carries `statement_timeout` and
// `idle_in_transaction_session_timeout` as Postgres *startup parameters*, so
// the ceilings are in force from the connection's first query at zero extra
// round-trips. One pathological query (a whole-project search, a large
// confidence read) can otherwise hold a Neon connection and compute
// indefinitely, starving Hyperdrive for every other request.
//
// Long operations that legitimately outrun the default opt out through ONE
// registry — LONG_OPERATION_TIMEOUTS below — via
// withLongOperationTimeout(db, op), which runs that handle's queries under a
// transaction-local `SET LOCAL statement_timeout`. Nothing else may raise the
// ceiling: a new long operation adds an entry (with its reason) to that table.
// Tightening it per call site needs no registry entry (the agent SQL guard's
// 4s READ ONLY transaction in auth-worker/src/lib/agent/sql-guard.ts).

import postgres from "postgres"

/** Result metadata returned alongside every statement's rows. */
export interface AquillaMeta {
  changes: number
  rows_written: number
  rows_read: number
  last_row_id: number
  duration: number
  served_by: string
}

/** Shape returned by `.all()` / `.run()` / each `batch()` entry. */
export interface AquillaResult<T = Record<string, unknown>> {
  results: T[]
  success: true
  meta: AquillaMeta
}

/** A bound (or bindable) SQL statement. */
export interface AquillaStatement {
  bind(...args: unknown[]): AquillaStatement
  all<T = Record<string, unknown>>(): Promise<AquillaResult<T>>
  run<T = Record<string, unknown>>(): Promise<AquillaResult<T>>
  first<T = unknown>(colName?: string): Promise<T | null>
  raw<T = unknown[]>(): Promise<T[]>
}

/** The database handle the workers inject as `env.AQUILLA_PG`. */
export interface AquillaDb {
  prepare(query: string): AquillaStatement
  batch<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]>
  /** Pipelined variant of batch() — same atomicity + order, far fewer network
   *  round-trips. Optional: only the postgres.js-backed shim implements it;
   *  callers must fall back to batch() when absent. */
  batchPipelined?<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
  close(): Promise<void>
  /** Run a callback on one Postgres connection and commit all of its queries
   * atomically. Optional for lightweight test doubles; production PostgresDb
   * always implements it. The callback receives a transaction-bound handle,
   * so it must not call transaction() recursively. */
  transaction?<T>(fn: (tx: AquillaDb) => Promise<T>): Promise<T>
  /** Thread a user identity into every query on the returned handle (see
   *  PostgresDb.withUser) so RLS backstop policies apply. Optional — many
   *  test doubles implement only prepare/batch/exec/close; identity-sensitive
   *  call sites must feature-detect (`db.withUser?.(...) ?? db`) rather than
   *  assume it exists. */
  withUser?(userId: number | string | null): AquillaDb
  asAdmin?(): AquillaDb
  /** Thread a transaction-local `statement_timeout` into every query on the
   *  returned handle, overriding the connection default for one long
   *  operation. Optional — call sites feature-detect, or (preferably) go
   *  through withLongOperationTimeout() so the ceiling stays in the registry. */
  withStatementTimeout?(ms: number): AquillaDb
}

/** Default per-statement ceiling on every worker Postgres connection
 *  (AQU-1876). 15s is comfortably above the slowest normal request-path query
 *  and far below the point where a stuck query starves Hyperdrive. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000

/** Default ceiling on a transaction left open with the client idle (AQU-1876).
 *  Nothing here holds a transaction across non-DB work, so 30s only ever fires
 *  on a bug or a hung fetch — and it is what bounds the seq-allocation
 *  ledger's PENDING_ALLOC_TTL_MS assumption (see
 *  sync-worker/src/events/event-insert.ts): no write batch can hold its
 *  allocation anywhere near the 5-minute TTL. */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000

/**
 * THE one place an operation opts out of DEFAULT_STATEMENT_TIMEOUT_MS.
 *
 * Each entry is a named long operation with the reason it legitimately runs
 * past the request-path default. Reach them through
 * withLongOperationTimeout(db, op) — never by hand-writing a higher
 * `SET LOCAL statement_timeout` at a call site, so this table stays the
 * complete list of what may outlive 15s.
 */
export const LONG_OPERATION_TIMEOUTS = {
  /** Confidence / health neighbour retrieval (AQU-1005). The batched
   *  JOIN LATERAL covers every asker cell in a file at once, so on a large
   *  project it legitimately outruns a normal request-path query; 20s is the
   *  ceiling AQU-1005 set so a regression is a fast loud error rather than a
   *  silent convoy. */
  "confidence-neighbors": 20_000,
  /** Bulk import finalize (sync-worker `POST /import`). The finalize batch
   *  recomputes every per-file and per-section counter for a freshly imported
   *  file in one transaction — a full Bible is ~31k cells. */
  "import-finalize": 120_000,
  /** Projection rebuild (`/admin/projects/:id/rebuild-projection`). An admin
   *  one-off that replays a project's entire event log; minutes are the
   *  expected cost, and nobody is waiting on a page. */
  "project-rebuild": 300_000,
  /** D1→Postgres migration finalize (`/migrate/projects/:id/finalize`). Runs
   *  the same project-wide counter recompute as a rebuild, across a whole
   *  project's file set, at the end of a bulk ingest. */
  "migration-finalize": 300_000,
  /** CLI maintenance — backfills, seeds and data migrations under `scripts/`
   *  (see makeMaintenancePostgres). Not request-path work: no user is waiting,
   *  and the request-path cap would abort them mid-table. */
  "maintenance-script": 600_000,
} as const

export type LongOperation = keyof typeof LONG_OPERATION_TIMEOUTS

/**
 * Return a handle whose queries run under the registered ceiling for `op`,
 * or `db` itself when the executor does not support per-handle timeouts
 * (lightweight test doubles). The only sanctioned way to exceed
 * DEFAULT_STATEMENT_TIMEOUT_MS.
 */
export function withLongOperationTimeout(db: AquillaDb, op: LongOperation): AquillaDb {
  return db.withStatementTimeout?.(LONG_OPERATION_TIMEOUTS[op]) ?? db
}

/** Per-statement execution options (see PgRunOpts.prepare). */
export interface PgRunOpts {
  /** Issue the statement as a NAMED prepared statement (postgres.js
   *  `prepare: true`). Required for pipelining: postgres.js flags every
   *  parameterized UNprepared query `describeFirst`, which (a) costs an extra
   *  Describe⇆ParameterDescription round-trip per statement and (b) makes
   *  `execute()` return false, stalling the send queue until the response —
   *  i.e. `prepare: false` (the `unsafe()` default) serializes everything at
   *  2 RTTs/statement no matter how the caller schedules. With prepare on,
   *  only the first occurrence of each distinct SQL string pays the describe;
   *  repeats are Bind/Execute only and stream back-to-back (max_pipeline=100
   *  in flight). Hyperdrive supports named prepared statements. Executors
   *  that don't prepare (PGlite tests) may ignore this. */
  prepare?: boolean
}

/** Minimal neutral executor the handle runs against (postgres.js or PGlite). */
export interface PgExecutor {
  run(sql: string, params: unknown[], opts?: PgRunOpts): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  begin<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>
  /** Release the underlying connection (postgres.js per-request); no-op for PGlite tests. */
  close?(): Promise<void>
}

/** `?` placeholders → Postgres `$1,$2,…` (positional, in order). */
function toPg(query: string): string {
  let i = 0
  return query.replace(/\?/g, () => `$${++i}`)
}

function meta(rowCount: number, rowsRead: number): AquillaMeta {
  return { changes: rowCount, rows_written: rowCount, rows_read: rowsRead, last_row_id: 0, duration: 0, served_by: "shim" }
}

/** Identity mode for RLS threading. */
type IdentityMode =
  | { kind: "none" }                  // no identity — bare db handle, no SET LOCAL
  | { kind: "user"; userId: string }  // authenticated user path
  | { kind: "admin" }                 // explicit admin bypass

/** Transaction-local session settings a handle carries alongside its identity.
 *  Empty on an ordinary handle, so the connection-level defaults set in
 *  makePostgres() apply unchanged and no extra statement is sent. */
interface SessionSettings {
  /** Overrides the connection's statement_timeout for this handle's queries.
   *  Set only via withStatementTimeout() / withLongOperationTimeout(). */
  statementTimeoutMs?: number
}

/** True when there is nothing to SET, so a query may run outside a
 *  transaction (the fast path every ordinary read/write takes). */
function isBareSession(mode: IdentityMode, session: SessionSettings): boolean {
  return mode.kind === "none" && session.statementTimeoutMs == null
}

/**
 * Apply the identity + session SET LOCALs inside a transaction, then call `fn`.
 * Used by both batch() and individual query calls when either is set.
 */
async function withSession<T>(
  executor: PgExecutor,
  mode: IdentityMode,
  session: SessionSettings,
  fn: (tx: PgExecutor) => Promise<T>,
): Promise<T> {
  return executor.begin(async (tx) => {
    if (mode.kind === "user") {
      // SET LOCAL does not accept bind parameters ($1) in any Postgres version
      // (GUC assignment syntax).  userId is always a String(numericId) coming
      // from withUser() — numeric, safe to embed directly.
      await tx.run(`SET LOCAL app.user_id = '${mode.userId}'`, [])
    } else if (mode.kind === "admin") {
      await tx.run("SET LOCAL app.user_id = ''", [])
    }
    // kind === "none": no SET LOCAL — bare executor (identity-less, no RLS in tests)
    if (session.statementTimeoutMs != null) {
      // Transaction-scoped, so it reverts with this mini-transaction and can
      // never leak onto the next request that reuses the pooled connection.
      // The value is a positive integer validated in withStatementTimeout(),
      // never caller text — SET LOCAL takes no bind parameter.
      await tx.run(`SET LOCAL statement_timeout = ${session.statementTimeoutMs}`, [])
    }
    return fn(tx)
  })
}

class PgStatement implements AquillaStatement {
  private executor: PgExecutor
  private mode: IdentityMode
  private session: SessionSettings
  private query: string
  private args: unknown[]
  private opts: PgRunOpts

  constructor(
    executor: PgExecutor,
    mode: IdentityMode,
    query: string,
    args: unknown[] = [],
    opts: PgRunOpts = {},
    session: SessionSettings = {},
  ) {
    this.executor = executor
    this.mode = mode
    this.session = session
    this.query = query
    this.args = args
    this.opts = opts
  }

  bind(...args: unknown[]): PgStatement {
    return new PgStatement(this.executor, this.mode, this.query, args, this.opts, this.session)
  }

  private async runQuery(): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const pgQuery = toPg(this.query)
    const args = this.args
    if (isBareSession(this.mode, this.session)) {
      return this.executor.run(pgQuery, args, this.opts)
    }
    // Wrap in a transaction so SET LOCAL takes effect.
    return withSession(this.executor, this.mode, this.session, (tx) => tx.run(pgQuery, args, this.opts))
  }

  async all<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    const { rows, rowCount } = await this.runQuery()
    return { results: rows as unknown as T[], success: true as const, meta: meta(rowCount, rows.length) }
  }

  // `.run()` mirrors `.all()` shape (results may be empty for writes).
  async run<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    return this.all<T>()
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { rows } = await this.runQuery()
    const row = rows[0]
    if (row == null) return null
    return (colName != null ? (row[colName] as T) : (row as unknown as T))
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = await this.runQuery()
    return rows.map((r) => Object.values(r) as unknown as T)
  }

  /** Re-bind this statement onto a specific executor (used inside batch). */
  _on(tx: PgExecutor, opts: PgRunOpts = {}) {
    return new PgStatement(tx, { kind: "none" }, this.query, this.args, opts)
  }

  /** The raw SQL text — batchPipelined groups statements by it (proxy for the
   *  postgres.js prepared-statement signature). */
  _sql(): string {
    return this.query
  }
}

export class PostgresDb implements AquillaDb {
  private executor: PgExecutor
  private mode: IdentityMode
  private session: SessionSettings

  constructor(
    executor: PgExecutor,
    mode: IdentityMode = { kind: "none" },
    session: SessionSettings = {},
  ) {
    this.executor = executor
    this.mode = mode
    this.session = session
  }

  /**
   * Return a new handle that threads the given numeric user id into every
   * query via `SET LOCAL app.user_id = '<userId>'` (inside a transaction).
   * Use at the request boundary for all authenticated paths.
   *
   * Pass null to explicitly clear a previously set identity (reverts to
   * bare handle — no SET LOCAL, no RLS enforcement).
   */
  withUser(userId: number | string | null): PostgresDb {
    if (userId == null) return new PostgresDb(this.executor, { kind: "none" }, this.session)
    // userId is embedded directly into `SET LOCAL app.user_id = '<userId>'`
    // (see withSession below — SET LOCAL can't take a bind parameter), so it
    // MUST be validated here rather than trusted from the caller: this is the
    // one place standing between an unvalidated string and a GUC-injection
    // primitive. users.id is BIGINT; reject anything that isn't a bare
    // non-negative integer literal.
    const id = String(userId)
    if (!/^\d+$/.test(id)) {
      throw new Error(`withUser: userId must be a non-negative integer, got ${JSON.stringify(userId)}`)
    }
    return new PostgresDb(this.executor, { kind: "user", userId: id }, this.session)
  }

  /**
   * Return a new handle that runs every query with `SET LOCAL app.user_id = ''`,
   * bypassing identity-gated RLS.  Callers MUST already be authorised through
   * a non-DB mechanism (SYNC_SECRET_KEY, DIARIZATION_SHARED_SECRET,
   * PLATFORM_ADMINS gate, etc.).
   *
   * Named call sites (AQU-289 audit — see db/postgres/RLS.md §Named asAdmin call sites):
   *   sync-worker: rebuild, rebuild-fts, migrate-*, import, import-morph,
   *                diarization callback, admin/files
   *   auth-worker: routes/admin.ts (platform-admin cross-tenant reads)
   */
  asAdmin(): PostgresDb {
    return new PostgresDb(this.executor, { kind: "admin" }, this.session)
  }

  /**
   * Return a handle whose every query runs under `SET LOCAL statement_timeout
   * = ms`, overriding the connection default from makePostgres(). Identity is
   * carried over, and the setting is transaction-local, so it cannot leak to
   * the next request on the same pooled connection.
   *
   * Prefer withLongOperationTimeout(db, op): the ceiling then lives in
   * LONG_OPERATION_TIMEOUTS with the reason it exists, which is the whole
   * point of having one registry.
   */
  withStatementTimeout(ms: number): PostgresDb {
    if (!Number.isInteger(ms) || ms <= 0) {
      // The value is interpolated into SQL (SET LOCAL takes no bind
      // parameter), so this is the gate between a caller and a GUC-injection
      // primitive — not merely an argument check.
      throw new Error(`withStatementTimeout: ms must be a positive integer, got ${JSON.stringify(ms)}`)
    }
    return new PostgresDb(this.executor, this.mode, { ...this.session, statementTimeoutMs: ms })
  }

  prepare(query: string): PgStatement {
    return new PgStatement(this.executor, this.mode, query, [], {}, this.session)
  }

  /** One batch = one atomic transaction; returns one result per statement. */
  async batch<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]> {
    const run = async (tx: PgExecutor): Promise<AquillaResult<T>[]> => {
      const out: AquillaResult<T>[] = []
      for (const s of stmts) out.push(await (s as PgStatement)._on(tx).all<T>())
      return out
    }
    if (isBareSession(this.mode, this.session)) {
      return this.executor.begin(run)
    }
    return withSession(this.executor, this.mode, this.session, run)
  }

  /** Like batch(), but PIPELINED: runs of statements are dispatched on the
   *  transaction connection before any response is awaited, so postgres.js
   *  streams them back-to-back and N per-statement network round-trips collapse
   *  toward N/100 (its max_pipeline window).
   *
   *  postgres.js only pipelines a statement whose execute() returns true, which
   *  requires (a) PREPARED ({ prepare: true }) — an unprepared parameterized
   *  query is `describeFirst`: an extra Describe⇆ round-trip AND an execute()
   *  stall — and (b) a signature already in the connection's statement cache.
   *  Any stalled statement moves the connection to postgres.js's `full` queue,
   *  after which its queued queries drain ONE PER ROUND-TRIP (see
   *  connection.js ReadyForQuery → connection.reserved()). A plain
   *  Promise.all therefore serializes at 1-2 RTTs per statement (~21 stmts/s
   *  through Hyperdrive↔Neon — the original migrate-ingest symptom).
   *
   *  So: the FIRST occurrence of each distinct SQL shape runs alone (awaited —
   *  this Parses + caches the prepared statement), and each following run of
   *  already-prepared statements is dispatched concurrently in waves capped at
   *  the max_pipeline window. Order is preserved — waves are sequential, and
   *  within a wave statements are written in array order on a single
   *  connection, so Postgres still executes them sequentially (a deselect
   *  before its upsert stays before it). Same atomicity as batch(): any
   *  failure rolls the lot back (later waves are never dispatched).
   *
   *  Signature tracking is per-call and by SQL text only: postgres.js keys its
   *  cache by inferred param types + text and per connection, so a mismatch
   *  (fresh pooled connection, or a bool/Date param changing the inferred
   *  types) just degrades that wave to the serial drain — correct, only
   *  slower — and the next wave pipelines again. */
  async batchPipelined<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]> {
    // postgres.js max_pipeline is 100; execute() past the window stalls the
    // connection into the serial drain, so cap waves at it.
    const WAVE = 100
    const run = async (tx: PgExecutor): Promise<AquillaResult<T>[]> => {
      const out: AquillaResult<T>[] = new Array(stmts.length)
      const prepared = new Set<string>()
      let i = 0
      while (i < stmts.length) {
        const s = stmts[i] as PgStatement
        if (!prepared.has(s._sql())) {
          out[i] = await s._on(tx, { prepare: true }).all<T>()
          prepared.add(s._sql())
          i++
          continue
        }
        const wave: Array<Promise<void>> = []
        while (i < stmts.length && wave.length < WAVE) {
          const w = stmts[i] as PgStatement
          if (!prepared.has(w._sql())) break
          const at = i++
          wave.push(w._on(tx, { prepare: true }).all<T>().then((r) => { out[at] = r }))
        }
        await Promise.all(wave)
      }
      return out
    }
    if (isBareSession(this.mode, this.session)) {
      return this.executor.begin(run)
    }
    return withSession(this.executor, this.mode, this.session, run)
  }

  /** Run arbitrary dependent statements in one transaction. Unlike batch(),
   * this supports reading a generated id and binding it into later statements. */
  async transaction<T>(fn: (tx: AquillaDb) => Promise<T>): Promise<T> {
    const run = (tx: PgExecutor): Promise<T> =>
      fn(new PostgresDb(tx, { kind: "none" }))
    if (isBareSession(this.mode, this.session)) {
      return this.executor.begin(run)
    }
    return withSession(this.executor, this.mode, this.session, run)
  }

  /** Run statements with no bound params. */
  async exec(query: string) {
    const { rowCount } = await this.executor.run(query, [])
    return { count: rowCount, duration: 0 }
  }

  /** Release the connection — call via ctx.waitUntil() after the response. */
  async close() {
    await this.executor.close?.()
  }
}

/** postgres.js → PgExecutor (prod path; over Hyperdrive's connection string). */
function fromPostgresJs(sql: postgres.Sql): PgExecutor {
  const wrap = (s: postgres.Sql): PgExecutor => ({
    async run(query, params, opts) {
      const rows = (await s.unsafe(query, params as never[], opts?.prepare ? { prepare: true } : undefined)) as unknown as Record<string, unknown>[] & { count?: number }
      return { rows, rowCount: rows.count ?? rows.length }
    },
    begin: (fn) => s.begin((tx) => fn(wrap(tx as unknown as postgres.Sql))) as Promise<never>,
    close: () => sql.end({ timeout: 5 }),
  })
  return wrap(sql)
}

/** Build an Aquilla database handle from a Postgres connection string (prod). */
/** Per-request pool size. The events route fans out SIX prefetch SELECTs in
 *  one Promise.all (route.ts PERF-2) — at max=5 the sixth always queued behind
 *  a full pool, i.e. one guaranteed extra round-trip on every flush. 8 covers
 *  that fan-out with headroom for the concurrent membership/settings reads
 *  that follow, and connections are opened lazily (postgres.js dials only when
 *  a query has to wait), so a simple request still uses one or two. Hyperdrive
 *  pools the origin side, so the cost of the extra client connections is
 *  local to the Worker isolate and bounded by the request's lifetime. */
export const DEFAULT_POOL_MAX = 8

/** Per-connection timeout overrides for makePostgres(). Omitted fields take
 *  the DEFAULT_* constants; `null` means "no ceiling" and is only for CLI
 *  maintenance (makeMaintenancePostgres), never a worker request path. */
export interface PgTimeoutOptions {
  statementTimeoutMs?: number | null
  idleInTransactionTimeoutMs?: number | null
}

/**
 * The Postgres startup parameters that carry this connection's timeouts.
 *
 * Startup parameters (rather than a `SET` after connecting) because they are
 * in force for the connection's very first query and cost no round-trip, and
 * because postgres.js opens pool connections lazily — there is no post-connect
 * hook where a `SET` could reliably run. Values are stringified ms, which
 * Postgres reads as milliseconds for both GUCs.
 *
 * Exported for the unit test: a timeout silently dropped from the startup
 * message is a no-op in production that nothing else would catch.
 */
export function pgTimeoutConnectionParams(opts: PgTimeoutOptions = {}): Record<string, string> {
  const params: Record<string, string> = {}
  const statement = opts.statementTimeoutMs === undefined ? DEFAULT_STATEMENT_TIMEOUT_MS : opts.statementTimeoutMs
  const idle = opts.idleInTransactionTimeoutMs === undefined
    ? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS
    : opts.idleInTransactionTimeoutMs
  if (statement != null) params.statement_timeout = String(statement)
  if (idle != null) params.idle_in_transaction_session_timeout = String(idle)
  return params
}

export function makePostgres(
  connectionString: string,
  max = DEFAULT_POOL_MAX,
  timeouts: PgTimeoutOptions = {},
): PostgresDb {
  const sql = postgres(connectionString, {
    max,
    fetch_types: false, // recommended through Hyperdrive's pooling
    // AQU-1876: statement / idle-in-transaction ceilings on every connection.
    connection: pgTimeoutConnectionParams(timeouts),
    types: {
      bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | bigint) => String(x) },
      // SUM() over a bigint column (e.g. cell_audio.duration_ms) returns numeric
      // (oid 1700), not bigint — coerce it to a JS number too, else aggregates
      // come back as strings. Values are counts/ms/word-totals, all < 2^53.
      numeric: { to: 1700, from: [1700], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
      timestamp: { to: 1114, from: [1114, 1184], parse: (x: string) => x, serialize: (x: string) => x },
    },
  })
  return new PostgresDb(fromPostgresJs(sql))
}

/**
 * Handle for CLI maintenance under `scripts/` — backfills, seeds, data
 * migrations. These are not request-path work: no user is waiting, a single
 * statement may legitimately scan a whole table, and the request-path
 * DEFAULT_STATEMENT_TIMEOUT_MS would abort them mid-run. They get the
 * registry's `maintenance-script` ceiling instead of no ceiling at all, so a
 * runaway maintenance query still cannot pin a Neon connection forever.
 * A script that needs something else sets its own `SET statement_timeout`
 * (neon-backfill-lanes.ts does), which overrides this for its session.
 */
export function makeMaintenancePostgres(connectionString: string, max = 1): PostgresDb {
  return makePostgres(connectionString, max, {
    statementTimeoutMs: LONG_OPERATION_TIMEOUTS["maintenance-script"],
  })
}
