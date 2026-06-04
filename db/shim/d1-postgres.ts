// D1-compatible shim over Postgres, for the D1→Neon migration.
//
// Both workers speak the D1 binding API (`prepare().bind().run()/all()/first()`,
// `batch()`, `exec()`). This shim presents the same surface backed by Postgres,
// so the ~83 files that use `env.AQUILLA_DB` keep working unchanged. Inject it
// where the D1 binding is read and cast to `D1Database`.
//
// The shim is executor-agnostic: prod uses postgres.js over Hyperdrive
// (`makeD1Postgres`), tests use PGlite (real Postgres in WASM) via a PGlite
// `PgExecutor` adapter — so tests exercise the exact same code + real dialect.
//
// Two things differ between D1 and a generic PG driver and MUST be handled:
//   1. placeholders — D1 `?` → Postgres `$1,$2,…`  (translated below)
//   2. return types — D1 returned BIGINT as JS number and DATETIME as a string;
//      the postgres.js executor overrides parsers so int8 → Number and
//      timestamp/timestamptz → string, matching D1.
//
// NOT handled here (fixed in the SQL itself — Stage B dialect sweep):
//   INSERT OR IGNORE → ON CONFLICT DO NOTHING, FTS `MATCH` → `@@ tsquery`, etc.
//
// Caveat: `?`→`$n` is textual; it assumes `?` appears only as a placeholder
// (true for this codebase — string literals use single quotes).
import postgres from "postgres"

/** Minimal neutral executor the shim runs against (postgres.js or PGlite). */
export interface PgExecutor {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  begin<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>
  /** Release the underlying connection (postgres.js per-request); no-op for PGlite tests. */
  close?(): Promise<void>
}

/** D1 `?` placeholders → Postgres `$1,$2,…` (positional, in order). */
function toPg(query: string): string {
  let i = 0
  return query.replace(/\?/g, () => `$${++i}`)
}

function meta(rowCount: number, rowsRead: number) {
  return { changes: rowCount, rows_written: rowCount, rows_read: rowsRead, last_row_id: 0, duration: 0, served_by: "shim" }
}

class PgStatement {
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

  async all<T = Record<string, unknown>>() {
    const { rows, rowCount } = await this.exec.run(toPg(this.query), this.args)
    return { results: rows as unknown as T[], success: true as const, meta: meta(rowCount, rows.length) }
  }

  // D1 `.run()` mirrors `.all()` shape (results may be empty for writes).
  async run<T = Record<string, unknown>>() {
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

export class D1Postgres {
  private executor: PgExecutor

  constructor(executor: PgExecutor) {
    this.executor = executor
  }

  prepare(query: string): PgStatement {
    return new PgStatement(this.executor, query)
  }

  /** D1 batch = one atomic transaction; returns one result per statement. */
  async batch<T = Record<string, unknown>>(stmts: PgStatement[]) {
    return this.executor.begin(async (tx) => {
      const out: Array<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> = []
      for (const s of stmts) out.push(await s._on(tx).all<T>())
      return out
    })
  }

  /** D1 exec = run statements with no bound params. */
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

/** Build a D1-compatible handle from a Postgres connection string (prod). */
export function makeD1Postgres(connectionString: string, max = 5): D1Postgres {
  const sql = postgres(connectionString, {
    max,
    fetch_types: false, // recommended through Hyperdrive's pooling
    types: {
      bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | bigint) => String(x) },
      timestamp: { to: 1114, from: [1114, 1184], parse: (x: string) => x, serialize: (x: string) => x },
    },
  })
  return new D1Postgres(fromPostgresJs(sql))
}
