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

interface FileRow {
  id: string
  name: string
  book_code: string | null
  role: string | null
}

/**
 * AQU-846: the project's files, target-role first. Used only when nothing
 * points at a file — to auto-pick when there is genuinely one candidate, and
 * to name the candidates when there is more than one.
 */
async function listCandidateFiles(db: AquillaDb, projectId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, book_code, role FROM files
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY role = 'target' DESC, name ASC
       LIMIT 25`,
    )
    .bind(projectId)
    .all<FileRow>()
  return results ?? []
}

/**
 * AQU-846: with no file focused and no file named, the agent used to be told
 * only "give a fileId or a ref" — so it went looking and silently drafted into
 * whichever file it found first. Now it auto-picks ONLY when the project has
 * one candidate document, and otherwise must ask the user.
 */
async function resolveUnfocusedScope(
  db: AquillaDb,
  projectId: string,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const files = await listCandidateFiles(db, projectId)
  if (files.length === 0) return { ok: false, error: "this project has no files yet" }
  // Source/target rows of the same document are one candidate, not two.
  const documents = new Set(files.map((f) => (f.book_code ?? f.name).toUpperCase()))
  if (documents.size === 1) return { ok: true, fileId: files[0].id }
  return {
    ok: false,
    error:
      "no file is open and this request does not name one — ASK THE USER which file to work in and stop; do NOT pick one yourself. Files: " +
      files.map((f) => f.name).join(", "),
  }
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

  // AQU-846: a ref the model derived from the file it just read ("GEN 1:6-10")
  // must not send the work somewhere else. When the focused file already IS
  // that book, it wins over the book-code lookup, whose name/ref fallbacks can
  // land on a different file. A ref naming a DIFFERENT book still resolves by
  // book code below, so "the next five verses of Mark" keeps targeting Mark.
  if (!fileId && range && ctx.focusedFileId) {
    const focused = await db
      .prepare(
        `SELECT id, book_code FROM files
         WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(ctx.projectId, ctx.focusedFileId)
      .first<{ id: string; book_code: string | null }>()
    if (focused?.book_code && focused.book_code.toUpperCase() === range.book) {
      fileId = focused.id
    }
  }
  if (!fileId && range) {
    const file = await resolveFileByBook(db, ctx.projectId, range.book)
    if (!file) return { ok: false, error: `no file with book code ${range.book} in this project` }
    fileId = file.id
  }
  if (!fileId) {
    if (ctx.focusedFileId) return { ok: true, fileId: ctx.focusedFileId, range }
    const unfocused = await resolveUnfocusedScope(db, ctx.projectId)
    if (!unfocused.ok) return unfocused
    fileId = unfocused.fileId
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
