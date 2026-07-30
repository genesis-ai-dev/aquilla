// SQL guard for the translation agent's read path (implementation plan
// §"Server internals" / design §5).
//
// Deliberately a token-level gate, NOT a SQL parser — small enough to audit:
//   1. Exactly one statement (no `;` chains), starting with SELECT or WITH.
//   2. No comments, no dollar-quoting, no banned keywords anywhere
//      (DML/DDL/transaction-control/SET/…), checked on a copy with string
//      literals masked so a literal can't hide or fake a keyword.
//   3. Must reference `:project` — v1 project scoping is app-level (the
//      bound project id + `SET LOCAL app.project_id`), so an unscoped query
//      is rejected outright.
//   4. `:project`/`:user`/`:file`/`:cell` and result aliases (#c1/#e1/#f1)
//      are bound as parameters — the model never sees or types a UUID.
//   5. Execution wraps in a READ ONLY transaction with statement_timeout 4s
//      and a 200-row cap (201 fetched so overflow is detectable).
//
// Defence in depth: even if a hostile SELECT slipped through, the READ ONLY
// transaction makes writes fail at the database.

import { AliasMap, ROW_CAP } from "./compress"

/** Dynamic variables the harness binds server-side (design §3 L1.4). */
export interface SqlVarContext {
  projectId: string
  userId: number
  /** Focused file, when the client sent one. */
  fileId?: string
  /** Focused cell, when the client sent one. */
  cellId?: string
}

export type SqlGuardResult =
  | { ok: true; sql: string; params: unknown[] }
  | { ok: false; error: string }

// Single-quoted literal with '' escaping. Masked before keyword checks.
const STRING_LITERAL_RE = /'(?:[^']|'')*'/g

// Any of these appearing as a word anywhere is an instant reject. Generous on
// purpose — false positives cost the model a retry with a reworded query;
// false negatives cost us the database.
const BANNED_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "grant", "revoke", "copy", "merge", "call", "do", "execute", "prepare",
  "deallocate", "set", "reset", "show", "vacuum", "analyze", "analyse",
  "reindex", "cluster", "lock", "listen", "notify", "unlisten", "discard",
  "refresh", "comment", "security", "begin", "commit", "rollback",
  "savepoint", "abort", "into",
] as const

// Functions with side effects (or abuse value) that survive the keyword scan
// because of word-boundary rules (`set_config` ≠ `\bset\b`). The READ ONLY
// transaction already blocks data writes; this list closes GUC/timing/file
// tricks too.
const BANNED_FUNCTIONS = [
  "set_config", "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_read_file",
  "pg_read_binary_file", "pg_ls_dir", "pg_terminate_backend", "pg_cancel_backend",
  "pg_notify", "dblink", "lo_import", "lo_export", "pg_reload_conf",
] as const

// Columns with no legitimate read use through this tool, banned outright
// regardless of project scoping (AQU pen-test finding, 2026-07-29): `users`
// has no RLS backstop (db/postgres/migrations/0034 doesn't cover it), so a
// scoping-check bypass — see reachableScopingText() below — would otherwise
// be able to exfiltrate every credential on the platform in one query. The
// assignments/project_members cookbook (docs.ts) only ever selects
// username/id/role_level from `users`, never this column.
const BANNED_COLUMNS = ["password_hash"] as const

const KNOWN_VARS = ["project", "user", "file", "cell"] as const

/**
 * When `masked` is a `WITH … SELECT`, restrict :project-scoping evidence to
 * text actually reachable from the final query: the main query itself, plus
 * the bodies of any CTEs it (transitively) references. Non-WITH queries pass
 * through unchanged.
 *
 * WHY (AQU pen-test finding, 2026-07-29): an unreferenced CTE is still valid
 * SQL — Postgres computes and discards it — so a "decoy" CTE like
 *   WITH _x AS (SELECT project_id FROM cells WHERE project_id = :project)
 *   SELECT * FROM users
 * used to satisfy the whole-string :project check in guardSql() below while
 * the actual returned rows (from `users`, which has no RLS backstop) were
 * completely unscoped. Restricting the check to reachable text closes this
 * shape. It does NOT (and, as text analysis, cannot) verify that a
 * *referenced* CTE actually correlates with every table it's joined
 * against — the same residual gap the module-level comment already documents
 * for RLS-backed tables (`cells c1 JOIN cells c2 ON 1=1`) applies here too;
 * RLS is the real backstop where it exists, and BANNED_COLUMNS above closes
 * the worst-case impact (credential exfiltration) where it doesn't.
 *
 * Fails closed on any shape it can't confidently parse — e.g. an unbalanced
 * CTE body returns "" (no reachable text at all) rather than trusting an
 * ambiguous string.
 */
function reachableScopingText(masked: string): string {
  const withMatch = /^with\s+/i.exec(masked)
  if (!withMatch) return masked
  let rest = masked.slice(withMatch[0].length).replace(/^recursive\s+/i, "")

  const ctes = new Map<string, string>()
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "")
    const head = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^()]*\))?\s*as\s*\(/i.exec(rest)
    if (!head) break
    const name = head[1].toLowerCase()
    let depth = 1
    let j = head[0].length
    while (j < rest.length && depth > 0) {
      if (rest[j] === "(") depth++
      else if (rest[j] === ")") depth--
      j++
    }
    if (depth !== 0) return "" // unbalanced parens — fail closed
    ctes.set(name, rest.slice(head[0].length, j - 1))
    rest = rest.slice(j)
  }
  const mainQuery = rest

  const referenced = new Set<string>()
  const queue = [mainQuery]
  while (queue.length > 0) {
    const text = queue.pop() as string
    for (const [name, body] of ctes) {
      if (referenced.has(name)) continue
      if (new RegExp(`\\b${name}\\b`, "i").test(text)) {
        referenced.add(name)
        queue.push(body)
      }
    }
  }

  let reachable = mainQuery
  for (const name of referenced) reachable += " " + ctes.get(name)
  return reachable
}

/**
 * Validate one model-authored SQL string and bind its variables/aliases.
 * Returns the parameterised single statement (still uncapped — the runner
 * wraps it with the row cap) or a model-readable rejection.
 */
export function guardSql(
  rawSql: string,
  vars: SqlVarContext,
  aliases: AliasMap,
): SqlGuardResult {
  let sql = rawSql.trim()
  if (!sql) return { ok: false, error: "empty sql" }
  // One optional trailing semicolon is tolerated; everything else isn't.
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd()

  // Mask string literals so keyword/structure checks can't be confused by
  // (or hidden inside) quoted text.
  const masked = sql.replace(STRING_LITERAL_RE, "'S'")
  // An unpaired quote survives masking — reject; the checks below can't be
  // trusted when the literal structure is ambiguous.
  if (masked.replace(/'S'/g, "").includes("'")) {
    return { ok: false, error: "unbalanced string literal" }
  }
  if (masked.includes(";")) {
    return { ok: false, error: "multiple statements are not allowed — send exactly one SELECT" }
  }
  if (masked.includes("--") || masked.includes("/*")) {
    return { ok: false, error: "comments are not allowed" }
  }
  if (masked.includes("$")) {
    return { ok: false, error: "dollar-quoting / positional parameters are not allowed" }
  }

  const firstWord = masked.match(/^[A-Za-z]+/)?.[0]?.toLowerCase()
  if (firstWord !== "select" && firstWord !== "with") {
    return { ok: false, error: "only a single SELECT (or WITH … SELECT) is allowed" }
  }

  for (const kw of BANNED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i")
    if (re.test(masked)) {
      return { ok: false, error: `keyword "${kw.toUpperCase()}" is not allowed in read-only SQL` }
    }
  }
  for (const fn of BANNED_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\b`, "i")
    if (re.test(masked)) {
      return { ok: false, error: `function "${fn}" is not allowed` }
    }
  }
  for (const col of BANNED_COLUMNS) {
    const re = new RegExp(`\\b${col}\\b`, "i")
    if (re.test(masked)) {
      return { ok: false, error: `column "${col}" is not allowed through this tool` }
    }
  }

  // Project scoping is mandatory (v1 app-level RLS) — EXCEPT pure catalog
  // introspection: a query whose only table references are information_schema
  // touches no project data and is the L3 escape hatch ("the agent is never
  // stuck"). Any project table name in the query re-imposes the requirement.
  const PROJECT_TABLES =
    /\b(cells|files|events|comments|assignments|assignment_cells|cell_validators|cell_waivers|cell_backtranslations|cell_audio|cell_word_morph|project_settings|project_members|users|agent_runs|chain_claims|project_seq_counters)\b/i
  const catalogOnly = /\binformation_schema\s*\./i.test(masked) && !PROJECT_TABLES.test(masked)
  // Require :project in an actual equality against a project_id column, not
  // merely present anywhere in the text — `WHERE project_id <> :project` (or
  // any other operator/unrelated clause) used to satisfy the old presence-only
  // check while excluding the caller's own project. This is app-level
  // defence-in-depth only: it cannot catch a query that correctly filters one
  // aliased table by :project while joining/selecting an unfiltered second
  // table of the same shape (e.g. `cells c1 JOIN cells c2 ON 1=1`) — that
  // cross-tenant case is closed at the database layer below via
  // `db.withUser()` + the RLS backstop (db/postgres/migrations/0034), not by
  // text analysis.
  const PROJECT_EQ_RE =
    /(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?project_id\s*=\s*(?<!:):project\b|(?<!:):project\b\s*=\s*(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?project_id\b/i
  // Scoped to text reachable from the final query (see reachableScopingText
  // doc comment) so a decoy, unreferenced CTE can't fake project scoping for
  // a table the main query actually reads.
  if (!catalogOnly && !PROJECT_EQ_RE.test(reachableScopingText(masked))) {
    return {
      ok: false,
      error: "query must filter on project_id = :project (all reads are project-scoped)",
    }
  }

  // Unknown :vars → reject before binding (a typo would otherwise reach PG
  // as a syntax error the model can't interpret). `::` casts are exempt;
  // scanned on the masked copy so literals can't false-positive.
  const varRefs = [...masked.matchAll(/(?<!:):([a-zA-Z_]+)\b/g)].map((m) => m[1])
  for (const v of varRefs) {
    if (!(KNOWN_VARS as readonly string[]).includes(v)) {
      return { ok: false, error: `unknown variable :${v} — available: :project :user :file :cell` }
    }
  }

  // Bind vars + aliases positionally, replacing each reference with `?`
  // (the AQUILLA_PG shim translates `?` → $n). Quoted forms ('#c1',
  // ':project') are accepted too — models love quoting things.
  const params: unknown[] = []
  const bindable = /'?(?<!:):(project|user|file|cell)\b'?|'?#([cef]\d+)'?/g
  let bindError: string | null = null
  const bound = sql.replace(bindable, (match, varName: string | undefined, _aliasBody: string | undefined) => {
    if (bindError) return match
    if (varName) {
      const value =
        varName === "project" ? vars.projectId
        : varName === "user" ? vars.userId
        : varName === "file" ? vars.fileId
        : vars.cellId
      if (value === undefined || value === null) {
        bindError = `:${varName} is not bound in this run (no focused ${varName})`
        return match
      }
      params.push(value)
      return "?"
    }
    const alias = match.replace(/'/g, "")
    const id = aliases.resolve(alias)
    if (!id) {
      bindError = `unknown alias ${alias} — aliases only exist after a query returned them`
      return match
    }
    params.push(id)
    return "?"
  })
  if (bindError) return { ok: false, error: bindError }

  return { ok: true, sql: bound, params }
}

export type SqlRunResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; error: string }

function escapeLiteral(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Guard + execute. The statement runs inside one transaction:
 * READ ONLY, statement_timeout 4s, app.project_id set for RLS-style
 * policies, row-capped at ROW_CAP+1 so the compressor can flag overflow.
 */
export async function runGuardedSql(
  db: AquillaDb,
  rawSql: string,
  vars: SqlVarContext,
  aliases: AliasMap,
): Promise<SqlRunResult> {
  const guarded = guardSql(rawSql, vars, aliases)
  if (!guarded.ok) return { ok: false, error: guarded.error }

  // ORDER BY inside the subquery is preserved by Postgres in practice; the
  // wrapper exists so a missing LIMIT can never stream an entire projection.
  const capped = `SELECT * FROM (${guarded.sql}) AS _agent_q LIMIT ${ROW_CAP + 1}`

  // Thread the caller's identity so the RLS backstop (db/postgres/migrations/
  // 0034_rls_backstop.sql) can filter rows the model's SQL text didn't scope
  // correctly — real defence-in-depth against the guard above being wrong or
  // incomplete for some query shape. Feature-detected: falls back to the bare
  // handle for test doubles that don't implement identity threading.
  const scopedDb = db.withUser?.(vars.userId) ?? db

  try {
    const results = await scopedDb.batch([
      scopedDb.prepare("SET TRANSACTION READ ONLY"),
      scopedDb.prepare("SET LOCAL statement_timeout = '4s'"),
      scopedDb.prepare(`SET LOCAL app.project_id = '${escapeLiteral(vars.projectId)}'`),
      scopedDb.prepare(capped).bind(...guarded.params),
    ])
    const last = results[results.length - 1]
    return { ok: true, rows: last.results as Record<string, unknown>[] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `sql error: ${message}` }
  }
}
