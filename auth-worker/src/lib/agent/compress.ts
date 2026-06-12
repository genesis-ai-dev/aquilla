// Result compression for the translation agent (design §4).
//
// `sql()` results are never raw JSON: rows render as a pipe-delimited table,
// nulls as ∅, UUIDs as per-run aliases (#c1 / #e1 / #f1) via a bidirectional
// legend the agent can hand back in later sql()/emit() calls. The table ends
// with a total line; when the 200-row cap is hit (we fetch 201 to detect
// overflow) the note says so explicitly — truncation is never silent.

export const ROW_CAP = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AliasKind = "c" | "e" | "f"

/**
 * Per-run bidirectional UUID↔alias map. Alias assignment is stable for the
 * lifetime of one agent run: the same UUID always compresses to the same
 * alias, and any alias the model echoes back resolves to its UUID.
 */
export class AliasMap {
  private idToAlias = new Map<string, string>()
  private aliasToId = new Map<string, string>()
  private counters: Record<AliasKind, number> = { c: 0, e: 0, f: 0 }

  alias(id: string, kind: AliasKind): string {
    const existing = this.idToAlias.get(id)
    if (existing) return existing
    const a = `#${kind}${++this.counters[kind]}`
    this.idToAlias.set(id, a)
    this.aliasToId.set(a, id)
    return a
  }

  /** Resolve an alias (e.g. "#c12") back to its UUID, or undefined. */
  resolve(alias: string): string | undefined {
    return this.aliasToId.get(alias)
  }

  /** True when the string looks like one of our aliases. */
  static isAlias(s: string): boolean {
    return /^#[cef]\d+$/.test(s)
  }
}

/** Which alias bucket a column's UUIDs belong to, by column name. */
export function aliasKindForColumn(column: string): AliasKind {
  const c = column.toLowerCase()
  if (c.includes("cell_id") || c === "cellid") return "c"
  if (c.includes("file_id") || c === "fileid") return "f"
  // event_id, parent_id, source_event_id, id (events table), everything else.
  return "e"
}

export interface CompressOptions {
  /** The run's project id — rendered as `:project` instead of an alias. */
  projectId?: string
  /** Max characters per cell value before truncation with an ellipsis. */
  maxCellChars?: number
}

function renderValue(
  value: unknown,
  column: string,
  aliases: AliasMap,
  opts: CompressOptions,
): string {
  if (value === null || value === undefined) return "∅"
  const s = typeof value === "string" ? value : String(value)
  if (UUID_RE.test(s)) {
    if (opts.projectId && s === opts.projectId) return ":project"
    return aliases.alias(s, aliasKindForColumn(column))
  }
  const max = opts.maxCellChars ?? 200
  // Pipes and newlines would break the table grammar.
  const flat = s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Compress a result set into the pipe-table block the model sees.
 *
 * Pass the raw rows from a 201-row fetch: when more than ROW_CAP rows arrive
 * the table is cut at ROW_CAP and an explicit overflow note is appended.
 */
export function compressRows(
  rows: Record<string, unknown>[],
  aliases: AliasMap,
  opts: CompressOptions = {},
): string {
  if (rows.length === 0) return "(0 rows)"

  const overflow = rows.length > ROW_CAP
  const shown = overflow ? rows.slice(0, ROW_CAP) : rows
  const columns = Object.keys(shown[0])

  const lines: string[] = []
  lines.push(columns.join("|"))
  for (const row of shown) {
    lines.push(columns.map((col) => renderValue(row[col], col, aliases, opts)).join("|"))
  }
  if (overflow) {
    lines.push(`(${ROW_CAP} rows shown — and more exist; refine or paginate)`)
  } else {
    lines.push(`(${shown.length} row${shown.length === 1 ? "" : "s"})`)
  }
  return lines.join("\n")
}
