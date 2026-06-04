// D1-compatible shim over Postgres (postgres.js), for the D1→Neon migration.
//
// Both workers speak the D1 binding API (`prepare().bind().run()/all()/first()`,
// `batch()`, `exec()`). This shim presents the same surface backed by a Postgres
// connection (reached via Hyperdrive in production), so the ~83 files that use
// `env.AQUILLA_DB` keep working unchanged. Inject it where the D1 binding is read
// and cast to `D1Database` (see each worker's index.ts).
//
// Only two things differ between D1 and a generic PG driver and MUST be handled
// for the app to behave identically:
//   1. placeholders — D1 uses `?`, Postgres uses `$1,$2,…`  (translated below)
//   2. return types — D1 returned BIGINT as JS number and DATETIME as a string;
//      postgres.js would give BigInt and Date. We override the type parsers so
//      int8 → Number and timestamp/timestamptz → raw string, matching D1.
//
// NOT handled here (must be fixed in the SQL itself — see Stage B dialect sweep):
//   INSERT OR IGNORE → ON CONFLICT DO NOTHING, FTS `MATCH` → `@@ tsquery`, etc.
//
// Caveat: `?`→`$n` translation is textual; it assumes `?` appears only as a bind
// placeholder (true for this codebase — string literals use single quotes). A `?`
// inside a literal would be mistranslated.
import postgres from "postgres"

type Sql = postgres.Sql<Record<string, never>>

/** D1 `?` placeholders → Postgres `$1,$2,…` (positional, in order). */
function toPg(query: string): string {
  let i = 0
  return query.replace(/\?/g, () => `$${++i}`)
}

function meta(rows: postgres.RowList<postgres.Row[]> | unknown) {
  const r = rows as { count?: number; length?: number }
  const count = r.count ?? r.length ?? 0
  return {
    changes: count,
    rows_written: count,
    rows_read: Array.isArray(rows) ? rows.length : 0,
    last_row_id: 0,
    duration: 0,
    served_by: "hyperdrive",
  }
}

class PgStatement {
  constructor(
    private exec: Sql,
    private query: string,
    private args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): PgStatement {
    return new PgStatement(this.exec, this.query, args)
  }

  async all<T = Record<string, unknown>>() {
    const rows = await this.exec.unsafe(toPg(this.query), this.args as never[])
    return { results: rows as unknown as T[], success: true as const, meta: meta(rows) }
  }

  async run<T = Record<string, unknown>>() {
    const rows = await this.exec.unsafe(toPg(this.query), this.args as never[])
    return { results: rows as unknown as T[], success: true as const, meta: meta(rows) }
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rows = await this.exec.unsafe(toPg(this.query), this.args as never[])
    const row = (rows as unknown[])[0] as Record<string, unknown> | undefined
    if (row == null) return null
    return (colName != null ? (row[colName] as T) : (row as unknown as T))
  }

  raw<T = unknown[]>(): Promise<T[]> {
    return this.exec
      .unsafe(toPg(this.query), this.args as never[])
      .then((rows) => (rows as Record<string, unknown>[]).map((r) => Object.values(r) as unknown as T))
  }

  // Internal: re-run this statement on a transaction handle (for batch()).
  _on(tx: Sql) {
    return new PgStatement(tx, this.query, this.args)
  }
}

class D1Postgres {
  constructor(private sql: Sql) {}

  prepare(query: string): PgStatement {
    return new PgStatement(this.sql, query)
  }

  /** D1 batch = one atomic transaction; returns one result per statement. */
  async batch<T = Record<string, unknown>>(stmts: PgStatement[]) {
    return this.sql.begin((tx) =>
      stmts.reduce<Promise<unknown[]>>(
        async (accP, s) => {
          const acc = await accP
          acc.push(await s._on(tx as unknown as Sql).all<T>())
          return acc
        },
        Promise.resolve([]),
      ),
    ) as Promise<Array<{ results: T[]; success: true; meta: ReturnType<typeof meta> }>>
  }

  /** D1 exec = run one or more statements with no bound params. */
  async exec(query: string) {
    const res = await this.sql.unsafe(query)
    return { count: Array.isArray(res) ? res.length : 0, duration: 0 }
  }
}

/**
 * Build a D1-compatible handle from a Postgres connection string (Hyperdrive's
 * `connectionString` in prod, or a direct Neon URL in dev). Cast the result to
 * `D1Database` at the injection site.
 */
export function makeD1Postgres(connectionString: string, max = 5) {
  const sql = postgres(connectionString, {
    max,
    fetch_types: false, // recommended through Hyperdrive's pooling
    types: {
      // int8/BIGINT → JS number (D1 returned numbers; our values fit MAX_SAFE_INTEGER).
      bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | bigint) => String(x) },
      // timestamp/timestamptz → raw string (D1's DATETIME came back as text, not Date).
      timestamp: { to: 1114, from: [1114, 1184], parse: (x: string) => x, serialize: (x: string) => x },
    },
  })
  return new D1Postgres(sql)
}

export type { D1Postgres }
