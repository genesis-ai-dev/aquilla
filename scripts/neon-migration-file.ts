// How one migration file is executed against live Postgres (AQU-1877).
//
// THE BUG THIS CLOSES
//
// The runner used to execute the file as one query and then write its
// `schema_migrations` row as a second, separate query. A crash, a dropped
// connection, or a Ctrl-C between the two left the migration applied but
// unrecorded, so the next `neon-migrate apply` ran it a second time. Nothing
// but the "every file is idempotent" convention stood between that and a
// double-applied DDL on production.
//
// The file and its ledger row now commit in ONE transaction, sent as ONE
// query: either both land or neither does. The ledger INSERT goes FIRST inside
// the transaction so that a failure anywhere in the file rolls the row back
// with it.
//
// THE EXPLICIT NON-TRANSACTIONAL PATH
//
// `CREATE INDEX CONCURRENTLY` (and `DROP`/`REINDEX … CONCURRENTLY`) cannot run
// inside a transaction block, so those files — detected by the keyword in
// executable SQL, comments and string literals excluded, or by an explicit
// `-- aquilla:no-transaction` marker — take a documented second path: each
// statement runs on its own in autocommit, and the ledger row is written after
// the last one. That path keeps the old crash window by construction, which is
// exactly why such a file must stay idempotent (`IF NOT EXISTS`): a re-run
// after a crash must be a no-op. It must not contain its own BEGIN/COMMIT.
//
// LOCK TIMEOUT
//
// Both paths set `lock_timeout` (default 5s, `AQUILLA_MIGRATION_LOCK_TIMEOUT`
// to override). An `ALTER TABLE` or a non-concurrent index build on `events`
// or `cells` takes a lock that blocks every write for as long as it runs; with
// no timeout, a migration queued behind one long transaction would hold that
// queue open indefinitely. The runner now fails fast and says so instead.
/**
 * All this module needs of a `pg.Client`: send one simple query. Narrowing it
 * keeps the runner testable without a database.
 */
export type SqlRunner = { query(text: string): Promise<unknown> }

const LEDGER = "schema_migrations"
export const DEFAULT_LOCK_TIMEOUT = "5s"
/** Postgres SQLSTATE for "could not obtain lock within lock_timeout". */
const LOCK_NOT_AVAILABLE = "55P03"
const NO_TRANSACTION_MARKER = /--[ \t]*aquilla:no-transaction\b/i
/** Filenames come off disk, but they are inlined into SQL below — keep them boring. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export type MigrationPlan = {
  /** `transactional`: file + ledger row in one transaction. */
  mode: "transactional" | "non-transactional"
  /** Why the non-transactional path was chosen, for the runner's log. */
  reason?: "concurrently" | "marker"
  /** Statements, for the non-transactional path. */
  statements: string[]
}

/**
 * Walk the SQL once, returning:
 *  - `code`: the file with comments, string literals and dollar-quoted bodies
 *    blanked out, so a keyword can be looked for in *executable* SQL only;
 *  - `statements`: top-level statements, split on semicolons that are not
 *    inside a comment, a literal, or a dollar-quoted body.
 */
export function scanSql(sql: string): { code: string; statements: string[] } {
  const statements: string[] = []
  let code = ""
  let stmtRaw = ""
  let stmtCode = ""
  let i = 0

  const endStatement = () => {
    // A trailing run of comments/whitespace is not a statement.
    if (stmtCode.replace(/[\s;]/g, "")) statements.push(stmtRaw.trim())
    stmtRaw = ""
    stmtCode = ""
  }
  const take = (raw: string, asCode: string) => {
    stmtRaw += raw
    stmtCode += asCode
    code += asCode
  }

  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i)
      const end = nl === -1 ? sql.length : nl
      take(sql.slice(i, end), " ")
      i = end
      continue
    }
    if (sql.startsWith("/*", i)) {
      // Block comments nest in Postgres.
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth += 1
          j += 2
        } else if (sql.startsWith("*/", j)) {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      take(sql.slice(i, j), " ")
      i = j
      continue
    }
    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
    if (dollarTag) {
      const tag = dollarTag[0]
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? sql.length : close + tag.length
      take(sql.slice(i, end), `${tag}${tag}`)
      i = end
      continue
    }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      // A quoted identifier is code; a string literal is blanked, so a keyword
      // inside quotes is never mistaken for SQL.
      take(sql.slice(i, j), ch === '"' ? sql.slice(i, j) : "''")
      i = j
      continue
    }
    take(ch, ch)
    i += 1
    if (ch === ";") endStatement()
  }
  endStatement()
  return { code, statements }
}

/** The file's own BEGIN/COMMIT, if it manages its transaction itself. */
export function hasOwnTransactionControl(sql: string): boolean {
  return /\b(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/i.test(scanSql(sql).code)
}

/** How this file has to be executed. */
export function planMigration(sql: string): MigrationPlan {
  const { code, statements } = scanSql(sql)
  const reason = NO_TRANSACTION_MARKER.test(sql)
    ? "marker"
    : /\bCONCURRENTLY\b/i.test(code)
      ? "concurrently"
      : undefined
  if (!reason) return { mode: "transactional", statements }
  return { mode: "non-transactional", reason, statements }
}

export function lockTimeoutSetting(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.AQUILLA_MIGRATION_LOCK_TIMEOUT?.trim()
  return value || DEFAULT_LOCK_TIMEOUT
}

function quote(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`
}

function ledgerInsert(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`migration name ${JSON.stringify(name)} is not a plain filename`)
  }
  return `INSERT INTO ${LEDGER} (name) VALUES (${quote(name)});`
}

/**
 * One query: BEGIN, the ledger row, the file, COMMIT. The ledger row is first
 * so a failure in the file rolls it back. A file that opens its own
 * transaction is tolerated — its BEGIN is a no-op notice and its COMMIT
 * commits this transaction, ledger row included.
 */
export function transactionalSql(name: string, sql: string, lockTimeout: string): string {
  const body = sql.trim()
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${quote(lockTimeout)};`,
    ledgerInsert(name),
    body.endsWith(";") ? body : `${body};`,
    "COMMIT;",
  ].join("\n")
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE
}

function lockTimeoutError(name: string, lockTimeout: string, recorded: boolean, cause: unknown): Error {
  return new Error(
    `✗ ${name} timed out waiting for a table lock (lock_timeout=${lockTimeout}).\n` +
      `  Something else holds a conflicting lock — a long transaction, an open ` +
      `psql session, or a worker mid-write. Nothing was changed and the ` +
      `migration is ${recorded ? "recorded, so re-check the ledger" : "NOT recorded"}; ` +
      `re-run apply once the DB is quiet (pg_stat_activity shows the blocker), or ` +
      `raise AQUILLA_MIGRATION_LOCK_TIMEOUT for a window where blocking writes is acceptable.`,
    { cause },
  )
}

/**
 * Apply one migration file and record it in the ledger, atomically where
 * Postgres allows it. Failures never advance the ledger.
 */
export async function applyMigrationFile(
  client: SqlRunner,
  name: string,
  sql: string,
  options: { lockTimeout?: string } = {},
): Promise<MigrationPlan> {
  const lockTimeout = options.lockTimeout ?? lockTimeoutSetting()
  const plan = planMigration(sql)

  if (plan.mode === "transactional") {
    try {
      await client.query(transactionalSql(name, sql, lockTimeout))
    } catch (error) {
      if (isLockTimeout(error)) throw lockTimeoutError(name, lockTimeout, false, error)
      throw error
    }
    return plan
  }

  if (hasOwnTransactionControl(sql)) {
    throw new Error(
      `✗ ${name} needs the non-transactional path (CONCURRENTLY) but contains its own ` +
        `BEGIN/COMMIT. Split the concurrent statements into their own migration file.`,
    )
  }
  // No transaction is possible here, so each statement commits on its own and
  // the ledger row lands after the last one. Such a file MUST be idempotent:
  // a crash mid-file leaves it unrecorded and it will run again.
  await client.query(`SET lock_timeout = ${quote(lockTimeout)}`)
  try {
    for (const statement of plan.statements) {
      await client.query(statement)
    }
    await client.query(ledgerInsert(name))
  } catch (error) {
    if (isLockTimeout(error)) throw lockTimeoutError(name, lockTimeout, false, error)
    throw error
  } finally {
    // Best effort: a dead connection must not mask the real failure.
    await client.query("SET lock_timeout = DEFAULT").catch(() => undefined)
  }
  return plan
}
