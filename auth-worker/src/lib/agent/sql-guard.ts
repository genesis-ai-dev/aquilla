// SQL guard for the translation agent's read path (implementation plan
// §"Server internals" / design §5).
//
// Deliberately a token-level gate, NOT a SQL parser — small enough to audit:
//   1. Exactly one statement (no `;` chains), starting with SELECT or WITH.
//   2. No comments, no dollar-quoting, no banned keywords anywhere
//      (DML/DDL/transaction-control/SET/…), checked on a copy with string
//      literals masked so a literal can't hide or fake a keyword.
//   3. Every relation read must be on the READABLE_TABLES allowlist, and each
//      reference to one is REWRITTEN into a project-scoped derived table, so
//      project scoping is structural rather than a property of the caller's
//      predicate (2026-09-28 pen-test finding). The `:project` text
//      requirement is kept in front of it as a legibility check.
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
  // Run an arbitrary query passed as a *string* — the string is masked, so the
  // guard never inspects (or project-scopes) it.
  "query_to_xml", "query_to_xml_and_xmlschema", "query_to_xmlschema",
  "table_to_xml", "table_to_xml_and_xmlschema", "table_to_xmlschema",
  "cursor_to_xml", "cursor_to_xmlschema", "schema_to_xml", "schema_to_xml_and_xmlschema",
  "database_to_xml", "database_to_xml_and_xmlschema",
] as const

// Columns with no legitimate read use through this tool, banned outright
// regardless of project scoping (AQU pen-test finding, 2026-07-29): `users`
// has no RLS backstop (db/postgres/migrations/0034 doesn't cover it), so a
// scoping-check bypass — see reachableScopingText() below — would otherwise
// be able to exfiltrate every credential on the platform in one query. The
// assignments/project_members cookbook (docs.ts) only ever selects
// username/id/role_level from `users`, never this column.
const BANNED_COLUMNS = ["password_hash"] as const

// Tables banned outright regardless of project scoping (AQU pen-test
// finding, 2026-09-23): `users` has no `project_id` column and no RLS
// backstop (db/postgres/migrations/0034 covers cells/events/files/comments/
// cell_validators/cell_audio/project_settings — not users), so the mandatory
// ":project scoping" check below (which only requires the substring
// `project_id = :project` to appear *somewhere* in the query, not that every
// joined table is actually filtered by it) does nothing to scope a join
// against `users`. A trivial, non-decoy query passes every existing check
// and returns every account on the platform:
//   SELECT c.cell_id, u.email, u.username FROM cells c
//   CROSS JOIN users u WHERE c.project_id = :project
// BANNED_COLUMNS closing password_hash alone was not enough — email,
// username and display_name are exactly the D3 identity data
// docs/OPSEC.md treats as sensitive. Banned outright rather than column-
// filtered: this tool has no way to verify a join against `users` is
// actually correlated to the caller's own project (see the residual-gap
// note on PROJECT_EQ_RE below), so any access to the table is unsafe. The
// assignments/project_members cookbook (docs.ts) no longer joins `users`.
const BANNED_TABLES = ["users"] as const

// ── Readable relations (allowlist) ──────────────────────────────────────────
// AQU pen-test finding, 2026-09-28. Until this change the tool was a
// *blocklist* over the whole database: any relation was reachable, and the
// only structural requirement was that the substring `project_id = :project`
// appear somewhere in the reachable query text. One correctly-scoped table
// therefore admitted an arbitrary second, unscoped one:
//
//   SELECT i.token, i.role_level, i.email
//   FROM cells c CROSS JOIN project_invites i
//   WHERE c.project_id = :project
//
// which returned every live invite token on the platform — each a working
// project-access credential at a stated role_level. The same shape reached
// project_access_links (token + scrypt PIN hash), cell_backtranslations,
// assignments, agent_memories and org_settings (the settings blob holds the
// user-supplied vendor API keys that routes/org-settings.ts redacts on read).
// `WHERE project_id = :project OR 1 = 1` and `WHERE NOT (project_id =
// :project)` satisfied the same check outright, on every table including the
// ones the model is meant to read. All of these were reproduced against the
// pre-fix guardSql().
//
// The comments below used to delegate that residual gap to the RLS backstop
// ("RLS is the real backstop where it exists"). It does not cover it: only 21
// of the schema's 55 project-scoped tables carry an RLS policy, and none of
// the tables named above is among them (db/postgres/RLS.md § What is
// protected).
//
// So the two halves of this are now:
//   * this allowlist — a relation not named here is rejected, whatever the
//     query does with it; and
//   * scopeRelations() — every reference to one of these tables is rewritten
//     into a project-scoped derived table, so scoping is STRUCTURAL. No
//     rewriting of the caller's predicate (OR, NOT, CASE, a correlated
//     subquery) can undo it, and correctness no longer depends on
//     PROJECT_EQ_RE below being exhaustive.
//
// The list is exactly the tables schema-card.ts documents to the model, minus
// `users` (banned outright since 2026-09-23). Values are the scoping template
// each reference is rewritten to. agent-sql-guard.test.ts pins the list
// against db/postgres/schema.sql and against the schema card, so neither a
// new table nor a newly documented one can join it silently.
export const READABLE_TABLES: Record<string, string> = {
  cells: "SELECT * FROM cells WHERE project_id = :project",
  files: "SELECT * FROM files WHERE project_id = :project",
  events: "SELECT * FROM events WHERE project_id = :project",
  comments: "SELECT * FROM comments WHERE project_id = :project",
  cell_validators: "SELECT * FROM cell_validators WHERE project_id = :project",
  cell_waivers: "SELECT * FROM cell_waivers WHERE project_id = :project",
  cell_backtranslations: "SELECT * FROM cell_backtranslations WHERE project_id = :project",
  cell_audio: "SELECT * FROM cell_audio WHERE project_id = :project",
  cell_word_morph: "SELECT * FROM cell_word_morph WHERE project_id = :project",
  assignments: "SELECT * FROM assignments WHERE project_id = :project",
  project_settings: "SELECT * FROM project_settings WHERE project_id = :project",
  // The termbase since 2026-09-04 (the projection of term.* events); the
  // `terminology` settings key it replaced is deleted on migration.
  concepts: "SELECT * FROM concepts WHERE project_id = :project",
  project_members: "SELECT * FROM project_members WHERE project_id = :project",
  // The one readable table with no project_id column of its own (PK is
  // (assignment_id, file_id, cell_id)); scoped through the assignment that
  // owns the row instead, which is.
  assignment_cells:
    "SELECT _aq_ac.* FROM assignment_cells _aq_ac" +
    " JOIN assignments _aq_a ON _aq_a.assignment_id = _aq_ac.assignment_id" +
    " AND _aq_a.project_id = :project",
}

/** `FROM`/`JOIN` occurrences introduce a relation reference we must resolve. */
const RELATION_KEYWORD_RE = /\b(from|join)\b/gi

/**
 * Words that may legally follow a relation reference without being its alias.
 * Anything else immediately after one is read as the alias.
 */
const NON_ALIAS_WORDS = new Set([
  "on", "using", "where", "group", "order", "limit", "offset", "having",
  "union", "except", "intersect", "join", "cross", "left", "right", "inner",
  "outer", "full", "natural", "and", "or", "window", "fetch", "for", "lateral",
  "tablesample", "asc", "desc", "returning", "with", "only",
])

/**
 * Functions whose own syntax puts a bare expression after the `FROM` keyword
 * (`EXTRACT(epoch FROM x)`, `SUBSTRING(s FROM 2)`, `TRIM(BOTH ' ' FROM s)`).
 * scanRelations() cannot tell those apart from a relation position, so they
 * are rejected with the replacement spelled out rather than mis-parsed. Every
 * one has an ordinary-call equivalent the model can use instead.
 */
const FROM_OPERAND_FUNCTIONS: Record<string, string> = {
  extract: "date_part('field', value)",
  substring: "substr(string, from, count)",
  overlay: "regexp_replace(...)",
  position: "strpos(haystack, needle)",
  trim: "btrim(string, characters)",
}

interface RelationRef {
  /** Lower-cased relation name as written (possibly `schema.table`). */
  name: string
  /** Offsets of the name itself in the statement (masked ≡ raw offsets). */
  start: number
  end: number
  /** Whether the reference already carries an alias. */
  aliased: boolean
}

type RelationScan = { ok: true; refs: RelationRef[] } | { ok: false; error: string }

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/

function skipSpace(text: string, at: number): number {
  let i = at
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Index just past the `)` matching the `(` at `open`, or -1 if unbalanced. */
function afterMatchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Every relation reference in the statement, in text order. Fails closed:
 * any shape it cannot read confidently is an error, not a skipped reference —
 * a missed reference would be a missed scoping rewrite.
 */
function scanRelations(masked: string): RelationScan {
  const refs: RelationRef[] = []
  for (const kwMatch of masked.matchAll(RELATION_KEYWORD_RE)) {
    const keyword = kwMatch[0].toLowerCase()
    const at = kwMatch.index
    // `IS [NOT] DISTINCT FROM` is a comparison operator, not a FROM clause.
    if (keyword === "from" && /\bdistinct\s*$/i.test(masked.slice(0, at))) continue
    let i = at + kwMatch[0].length
    // A FROM list is comma-separated; each JOIN brings exactly one.
    for (;;) {
      i = skipSpace(masked, i)
      if (/^lateral\b/i.test(masked.slice(i))) i = skipSpace(masked, i + "lateral".length)
      if (masked[i] === "(") {
        // Derived table / sub-select: its own FROM is matched on its own.
        const after = afterMatchingParen(masked, i)
        if (after < 0) return { ok: false, error: "unbalanced parentheses" }
        i = after
      } else {
        const nameMatch = IDENT_RE.exec(masked.slice(i))
        if (!nameMatch) {
          return {
            ok: false,
            error: `could not read the table name after ${keyword.toUpperCase()} — write a plain table reference`,
          }
        }
        let name = nameMatch[0]
        let end = i + name.length
        if (masked[end] === ".") {
          const qualified = IDENT_RE.exec(masked.slice(end + 1))
          if (!qualified) return { ok: false, error: "could not read the qualified table name" }
          name += "." + qualified[0]
          end += 1 + qualified[0].length
        }
        if (masked[skipSpace(masked, end)] === "(") {
          return { ok: false, error: `set-returning functions are not allowed in ${keyword.toUpperCase()}` }
        }
        refs.push({ name: name.toLowerCase(), start: i, end, aliased: false })
        i = end
      }
      const current = refs.length > 0 ? refs[refs.length - 1] : undefined
      const isRelation = current !== undefined && current.end === i
      // Optional alias, with or without AS, optionally with a column list.
      i = skipSpace(masked, i)
      let alias: string | null = null
      if (/^as\b/i.test(masked.slice(i))) {
        i = skipSpace(masked, i + 2)
        const aliasMatch = IDENT_RE.exec(masked.slice(i))
        if (!aliasMatch) return { ok: false, error: "could not read the table alias after AS" }
        alias = aliasMatch[0]
        i += alias.length
      } else {
        const aliasMatch = IDENT_RE.exec(masked.slice(i))
        if (aliasMatch && !NON_ALIAS_WORDS.has(aliasMatch[0].toLowerCase())) {
          alias = aliasMatch[0]
          i += alias.length
        }
      }
      if (alias !== null && isRelation) current.aliased = true
      i = skipSpace(masked, i)
      if (alias !== null && masked[i] === "(") {
        const after = afterMatchingParen(masked, i) // column alias list
        if (after < 0) return { ok: false, error: "unbalanced parentheses" }
        i = skipSpace(masked, after)
      }
      if (masked[i] !== ",") break
      i++
    }
  }
  return { ok: true, refs }
}

/**
 * CTE names defined by a leading `WITH`. A CTE reference is a relation
 * reference syntactically, so scanRelations() reports it and the allowlist
 * check below has to recognise it. Only top-level CTEs are collected: a
 * `WITH` nested inside a sub-select is not, so its name is rejected as an
 * unknown relation — fail-closed, and no cookbook query has that shape.
 */
function collectCteNames(masked: string): Set<string> {
  const names = new Set<string>()
  const withMatch = /^with\s+/i.exec(masked)
  if (!withMatch) return names
  let rest = masked.slice(withMatch[0].length).replace(/^recursive\s+/i, "")
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "")
    const head = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^()]*\))?\s*as\s*\(/i.exec(rest)
    if (!head) break
    const after = afterMatchingParen(rest, head[0].length - 1)
    if (after < 0) break
    names.add(head[1].toLowerCase())
    rest = rest.slice(after)
  }
  return names
}

/**
 * Rewrite every readable-table reference into its project-scoped derived
 * table, back to front so earlier offsets stay valid. An unaliased reference
 * is given the table's own name as the alias, so `cells.value` and bare
 * column references in the caller's query keep resolving.
 */
function scopeRelations(sql: string, refs: RelationRef[]): string {
  let out = sql
  for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
    const template = READABLE_TABLES[ref.name]
    if (!template) continue // information_schema / CTE — nothing to scope
    out = out.slice(0, ref.start) + `(${template})` + (ref.aliased ? "" : ` ${ref.name}`) + out.slice(ref.end)
  }
  return out
}

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
 * against. That residual gap (`cells c1 JOIN cells c2 ON 1=1`) is what
 * scopeRelations() closes structurally — it used to be delegated to the RLS
 * backstop, which does not cover most of the schema (2026-09-28 finding, see
 * READABLE_TABLES). This function is retained for its original purpose: not
 * crediting an unreachable CTE with satisfying the `:project` check.
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
  // (or hidden inside) quoted text. The mask is LENGTH-PRESERVING — each
  // literal becomes 's' repeated to its own width — so an offset found on the
  // masked copy addresses the same character in `sql`. scanRelations() below
  // depends on that: it finds relation references on the masked text and
  // scopeRelations() rewrites the real statement at those offsets.
  // Postgres escape-string (E'..\'..') and Unicode-escape (U&'..') literals use
  // backslash escapes the mask below doesn't model, letting a payload desync
  // the guard's view of literal boundaries from Postgres's and hide subqueries
  // (e.g. against `users`) inside a "literal". Reject them outright.
  if (/(^|[^A-Za-z0-9_$])(?:[eE]|[uU]&)\s*'/.test(sql)) {
    return { ok: false, error: "E'…' / U&'…' escape string literals are not allowed — use plain '…' literals" }
  }
  const masked = sql.replace(STRING_LITERAL_RE, (literal) => `'${"s".repeat(literal.length - 2)}'`)
  // An unpaired quote survives masking — reject; the checks below can't be
  // trusted when the literal structure is ambiguous.
  if (masked.replace(/'s*'/g, "").includes("'")) {
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
  for (const [fn, alternative] of Object.entries(FROM_OPERAND_FUNCTIONS)) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, "i")
    if (re.test(masked)) {
      return {
        ok: false,
        error: `${fn.toUpperCase()}(… FROM …) is not supported by this tool — use ${alternative} instead`,
      }
    }
  }
  for (const col of BANNED_COLUMNS) {
    const re = new RegExp(`\\b${col}\\b`, "i")
    if (re.test(masked)) {
      return { ok: false, error: `column "${col}" is not allowed through this tool` }
    }
  }
  for (const table of BANNED_TABLES) {
    const re = new RegExp(`\\b${table}\\b`, "i")
    if (re.test(masked)) {
      return { ok: false, error: `table "${table}" is not allowed through this tool` }
    }
  }

  // Project scoping is mandatory (v1 app-level RLS) — EXCEPT pure catalog
  // introspection: a query whose only table references are information_schema
  // touches no project data and is the L3 escape hatch ("the agent is never
  // stuck"). Any project table name in the query re-imposes the requirement.
  const PROJECT_TABLES =
    /\b(cells|files|events|comments|assignments|assignment_cells|cell_validators|cell_waivers|cell_backtranslations|cell_audio|cell_word_morph|project_settings|concepts|project_members|users|agent_runs|chain_claims|project_seq_counters|scene_briefs|contextual_runs|contextual_steering|contextual_drafts|contextual_run_events|contextual_project_leases)\b/i
  const catalogOnly = /\binformation_schema\s*\./i.test(masked) && !PROJECT_TABLES.test(masked)
  // Require :project in an actual equality against a project_id column, not
  // merely present anywhere in the text — `WHERE project_id <> :project` (or
  // any other operator/unrelated clause) used to satisfy the old presence-only
  // check while excluding the caller's own project. Text analysis can't
  // catch a query that filters one aliased table by :project while
  // joining an unfiltered second one (`cells c1 JOIN cells c2 ON 1=1`), nor
  // one that neutralises its own predicate (`… OR 1 = 1`, `NOT (…)`) — so it
  // is NOT what keeps reads project-scoped. scopeRelations() below is. This
  // check stays because a query that never mentions :project is a model
  // mistake worth naming precisely.
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

  // Resolve every relation the statement reads and reject anything not on the
  // allowlist, then rewrite each allowed reference into its project-scoped
  // derived table (see READABLE_TABLES). This — not PROJECT_EQ_RE above — is
  // what makes a second, unscoped table reference impossible.
  const scan = scanRelations(masked)
  if (!scan.ok) return { ok: false, error: scan.error }
  const cteNames = collectCteNames(masked)
  for (const cte of cteNames) {
    if (cte in READABLE_TABLES) {
      return {
        ok: false,
        error: `CTE name "${cte}" shadows a table of the same name — rename the CTE`,
      }
    }
  }
  for (const ref of scan.refs) {
    if (ref.name.startsWith("information_schema.")) continue
    if (cteNames.has(ref.name)) continue
    if (ref.name in READABLE_TABLES) continue
    return {
      ok: false,
      error:
        `table "${ref.name}" is not readable through this tool — readable: ` +
        `${Object.keys(READABLE_TABLES).join(", ")} (plus information_schema for introspection)`,
    }
  }
  const scoped = scopeRelations(sql, scan.refs)

  // Bind vars + aliases positionally, replacing each reference with `?`
  // (the AQUILLA_PG shim translates `?` → $n). Quoted forms ('#c1',
  // ':project') are accepted too — models love quoting things.
  const params: unknown[] = []
  const bindable = /'?(?<!:):(project|user|file|cell)\b'?|'?#([cef]\d+)'?/g
  let bindError: string | null = null
  const bound = scoped.replace(bindable, (match, varName: string | undefined, _aliasBody: string | undefined) => {
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

// `vars.projectId` is embedded directly into `SET LOCAL app.project_id =
// '<id>'` below (SET LOCAL can't take a bind parameter) — the same
// GUC-injection shape `PostgresDb.withUser()` already validates strictly for
// `app.user_id` (db/shim/postgres.ts). In practice this value only ever
// reaches here after `resolveProjectRole()` has looked it up via a
// parameterized query, so an attacker-chosen string can't survive that far —
// but that is a property of the caller, not of this function, so it is
// re-validated here rather than trusted (AQU pen-test finding, 2026-09-23,
// defense-in-depth alongside the BANNED_TABLES fix above). Every real
// project id observed in this codebase is a `crypto.randomUUID()` value;
// reject anything else before it reaches the query text.
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  if (!PROJECT_ID_RE.test(vars.projectId)) {
    return { ok: false, error: "internal: projectId is not a valid UUID" }
  }

  // ORDER BY inside the subquery is preserved by Postgres in practice; the
  // wrapper exists so a missing LIMIT can never stream an entire projection.
  const capped = `SELECT * FROM (${guarded.sql}) AS _agent_q LIMIT ${ROW_CAP + 1}`

  // Thread the caller's identity so the RLS backstop (db/postgres/migrations/
  // 0034_rls_backstop.sql) can filter rows the guard didn't — a third layer
  // under the allowlist and the scoping rewrite. Treat it as a bonus, not a
  // guarantee: it covers 21 of the schema's 55 project-scoped tables, and
  // whether the deployed Hyperdrive role is subject to it at all is not
  // verifiable from this repo (db/postgres/RLS.md § Deployment status).
  // Feature-detected: falls back to the bare handle for test doubles that
  // don't implement identity threading.
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
