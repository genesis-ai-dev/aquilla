// read — aligned source/target rows for a scope, in display order.
//
// Replaces the hand-written work-list SQL the old prompt taught: one call
// returns `cell|ref|status|source|target` rows (cells aliased so later
// draft/propose calls can address them) plus the typed PassageRow payload the
// client working set renders. Scope = focused file, an explicit fileId/alias,
// or a ref range ("MRK 4", "MRK 4:1-20") resolved via files.book_code.

import { AliasMap } from "../compress"
import {
  parseRefRange,
  resolveFileByBook,
  selectCellPairs,
  statusOf,
  type CellPair,
  type RefRange,
} from "./select-cells"
import type { PassageRow, ToolOutcome } from "./types"

export interface ReadArgs {
  fileId?: unknown
  ref?: unknown
  filter?: unknown
  limit?: unknown
  offset?: unknown
}

export interface ReadContext {
  projectId: string
  /** Focused file (:file). */
  focusedFileId?: string
  aliases: AliasMap
}

const FILTERS = new Set(["all", "untranslated", "stale", "flagged", "validated", "drafted"])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const CELL_TEXT_MAX = 160

export function clip(s: string, max = CELL_TEXT_MAX): string {
  const flat = s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Resolve {fileId?, ref?} to a concrete file id (+ parsed range). */
export async function resolveScope(
  db: AquillaDb,
  args: { fileId?: unknown; ref?: unknown },
  ctx: ReadContext,
): Promise<{ ok: true; fileId: string; range?: RefRange } | { ok: false; error: string }> {
  let range: RefRange | undefined
  if (args.ref !== undefined) {
    if (typeof args.ref !== "string") return { ok: false, error: "ref must be a string" }
    const parsed = parseRefRange(args.ref)
    if (!parsed) {
      return { ok: false, error: `unparseable ref "${args.ref}" — use "MRK", "MRK 4", or "MRK 4:1-20"` }
    }
    range = parsed
  }

  let fileId: string | undefined
  if (args.fileId !== undefined) {
    if (typeof args.fileId !== "string") return { ok: false, error: "fileId must be a string" }
    if (args.fileId === ":file") {
      if (!ctx.focusedFileId) return { ok: false, error: ":file is not bound (no focused file)" }
      fileId = ctx.focusedFileId
    } else if (AliasMap.isAlias(args.fileId)) {
      const resolved = ctx.aliases.resolve(args.fileId)
      if (!resolved) return { ok: false, error: `unknown alias ${args.fileId}` }
      fileId = resolved
    } else {
      fileId = args.fileId
    }
  }

  if (!fileId && range) {
    const file = await resolveFileByBook(db, ctx.projectId, range.book)
    if (!file) return { ok: false, error: `no file with book code ${range.book} in this project` }
    fileId = file.id
  }
  if (!fileId) {
    if (ctx.focusedFileId) fileId = ctx.focusedFileId
    else return { ok: false, error: "give a fileId or a ref (no file is focused)" }
  }
  return { ok: true, fileId, range }
}

export function pairToRow(pair: CellPair, fileId: string): PassageRow {
  const status = statusOf(pair)
  return {
    cellId: pair.cellId,
    fileId,
    ref: pair.canonicalRef ?? undefined,
    source: pair.source,
    target: pair.target,
    // "translated" is the unremarkable default — the wire enum omits it.
    ...(status !== "translated" ? { status } : {}),
  }
}

export async function executeRead(db: AquillaDb, args: ReadArgs, ctx: ReadContext): Promise<ToolOutcome> {
  const scope = await resolveScope(db, args, ctx)
  if (!scope.ok) return { ok: false, text: `error: ${scope.error}` }

  const filter = typeof args.filter === "string" ? args.filter : "all"
  if (!FILTERS.has(filter)) {
    return { ok: false, text: `error: unknown filter "${filter}" — one of ${[...FILTERS].join(" | ")}` }
  }
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number(args.offset) || 0, 0)

  const all = await selectCellPairs(db, ctx.projectId, { fileId: scope.fileId, range: scope.range })
  const filtered = filter === "all" ? all : all.filter((p) => statusOf(p) === filter)
  const page = filtered.slice(offset, offset + limit)

  if (page.length === 0) {
    return {
      ok: true,
      text: `0 of ${all.length} cells match (filter: ${filter}${scope.range ? `, ref scope` : ""}).`,
      data: { cells: [] },
    }
  }

  const fileAlias = ctx.aliases.alias(scope.fileId, "f")
  const lines = [`file ${fileAlias} — cell|ref|status|source|target`]
  for (const p of page) {
    lines.push(
      [
        ctx.aliases.alias(p.cellId, "c"),
        p.canonicalRef ?? "∅",
        statusOf(p),
        clip(p.source),
        p.target ? clip(p.target) : "∅",
      ].join("|"),
    )
  }
  const remaining = filtered.length - offset - page.length
  lines.push(
    remaining > 0
      ? `(${page.length} of ${filtered.length} shown — ${remaining} more; pass offset:${offset + page.length})`
      : `(${page.length} row${page.length === 1 ? "" : "s"})`,
  )

  return {
    ok: true,
    text: lines.join("\n"),
    data: { cells: page.map((p) => pairToRow(p, scope.fileId)) },
  }
}
