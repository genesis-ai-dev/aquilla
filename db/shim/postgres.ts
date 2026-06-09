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
  exec(query: string): Promise<{ count: number; duration: number }>
  close(): Promise<void>
}

/** Minimal neutral executor the handle runs against (postgres.js or PGlite). */
export interface PgExecutor {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
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

class PgStatement implements AquillaStatement {
  private exec: PgExecutor
  private query: string
  private args: unknown[]

  constructor(exec: PgExecutor, query: string, args: unknown[] = []) {
    this.exec = exec
    this.query = query
    this.args = args
  }

  bind(...args: unknown[]): PgStatement {
    return new PgStatement(this.exec, this.query, args)
  }

  async all<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    const { rows, rowCount } = await this.exec.run(toPg(this.query), this.args)
    return { results: rows as unknown as T[], success: true as const, meta: meta(rowCount, rows.length) }
  }

  // `.run()` mirrors `.all()` shape (results may be empty for writes).
  async run<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    return this.all<T>()
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { rows } = await this.exec.run(toPg(this.query), this.args)
    const row = rows[0]
    if (row == null) return null
    return (colName != null ? (row[colName] as T) : (row as unknown as T))
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = await this.exec.run(toPg(this.query), this.args)
    return rows.map((r) => Object.values(r) as unknown as T)
  }

  _on(tx: PgExecutor) {
    return new PgStatement(tx, this.query, this.args)
  }
}

export class PostgresDb implements AquillaDb {
  private executor: PgExecutor

  constructor(executor: PgExecutor) {
    this.executor = executor
  }

  prepare(query: string): PgStatement {
    return new PgStatement(this.executor, query)
  }

  /** One batch = one atomic transaction; returns one result per statement. */
  async batch<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]> {
    return this.executor.begin(async (tx) => {
      const out: AquillaResult<T>[] = []
      for (const s of stmts) out.push(await (s as PgStatement)._on(tx).all<T>())
      return out
    })
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
    async run(query, params) {
      const rows = (await s.unsafe(query, params as never[])) as unknown as Record<string, unknown>[] & { count?: number }
      return { rows, rowCount: rows.count ?? rows.length }
    },
    begin: (fn) => s.begin((tx) => fn(wrap(tx as unknown as postgres.Sql))) as Promise<never>,
    close: () => sql.end({ timeout: 5 }),
  })
  return wrap(sql)
}

/** Build an Aquilla database handle from a Postgres connection string (prod). */
export function makePostgres(connectionString: string, max = 5): PostgresDb {
  const sql = postgres(connectionString, {
    max,
    fetch_types: false, // recommended through Hyperdrive's pooling
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
