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

const KNOWN_VARS = ["project", "user", "file", "cell"] as const

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

  // Project scoping is mandatory (v1 app-level RLS) — EXCEPT pure catalog
  // introspection: a query whose only table references are information_schema
  // touches no project data and is the L3 escape hatch ("the agent is never
  // stuck"). Any project table name in the query re-imposes the requirement.
  const PROJECT_TABLES =
    /\b(cells|files|events|comments|assignments|assignment_cells|cell_validators|cell_waivers|cell_backtranslations|cell_audio|cell_word_morph|project_settings|project_members|users|agent_runs|chain_claims|project_seq_counters)\b/i
  const catalogOnly = /\binformation_schema\s*\./i.test(masked) && !PROJECT_TABLES.test(masked)
  if (!catalogOnly && !/(?<!:):project\b/.test(sql)) {
    return { ok: false, error: "query must reference :project (all reads are project-scoped)" }
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

  try {
    const results = await db.batch([
      db.prepare("SET TRANSACTION READ ONLY"),
      db.prepare("SET LOCAL statement_timeout = '4s'"),
      db.prepare(`SET LOCAL app.project_id = '${escapeLiteral(vars.projectId)}'`),
      db.prepare(capped).bind(...guarded.params),
    ])
    const last = results[results.length - 1]
    return { ok: true, rows: last.results as Record<string, unknown>[] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `sql error: ${message}` }
  }
}
