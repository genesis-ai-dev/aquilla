// read — aligned source/target rows for a scope, in display order.
//
// Replaces the hand-written work-list SQL the old prompt taught: one call
// returns `cell|ref|status|source|target` rows (cells aliased so later
// draft/propose calls can address them) plus the typed PassageRow payload the
// client working set renders. Scope = focused file, an explicit fileId/alias,
// a file name (AQU-1455), or a ref range ("<BOOK> 4", "<BOOK> 4:1-20") resolved
// via files.book_code.

import { PLAN_UNIT_FILE_PREDICATE } from "../../../../../db/shared/plan-units"
import { resolveLaneIdOrTag } from "../../../../../db/shared/lane-ref"
import { AliasMap } from "../compress"
import {
  parseRefRange,
  resolveFileByBook,
  selectCellPairs,
  statusOf,
  type CellPair,
  type RefRange,
} from "./select-cells"
import type { FileCandidate, PassageRow, ToolOutcome } from "./types"

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
  /** The active lane, as either its `lanes.id` or its legacy tag: resolved
   *  to the id every lane-scoped query keys on (AQU-1610). `''` is the
   *  project's former default lane. */
  lane: string
  aliases: AliasMap
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
  source_file_id: string | null
}

/**
 * AQU-846 / AQU-1455: the project's files, target-role first. Used only when
 * nothing points at a file — to auto-pick when there is genuinely one
 * candidate, and to name the candidates when there is more than one. The
 * hidden `audio-cues` sibling is not a candidate (PLAN_UNIT_FILE_PREDICATE
 * is the one definition of "a file someone works in").
 */
async function listCandidateFiles(db: AquillaDb, projectId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, f.book_code, f.role, f.source_file_id FROM files f
       WHERE f.project_id = ? AND ${PLAN_UNIT_FILE_PREDICATE}
       ORDER BY f.role = 'target' DESC, f.name ASC
       LIMIT 100`,
    )
    .bind(projectId)
    .all<FileRow>()
  return results ?? []
}

/** Lowercase, alphanumerics only: "Practice1_Come Before" -> "practice1comebefore". */
function compact(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

/** Words a user tacks on around a file name ("practise1 file"). */
const NAME_NOISE = new Set(["file", "files", "the", "document", "doc", "project", "my", "this", "of"])

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Group file rows into documents. Source/target rows of one document are one
 * candidate, not two: rows sharing the root of their source_file_id chain,
 * the same book code, or the same normalized name merge. The first row of
 * each group (target-role first, per the query order) represents it.
 */
function groupDocuments(files: FileRow[]): FileRow[] {
  const byId = new Map(files.map((f) => [f.id, f]))
  const parent = new Map<string, string>(files.map((f) => [f.id, f.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const seenKey = new Map<string, string>()
  const link = (key: string, id: string) => {
    const other = seenKey.get(key)
    if (other) union(other, id)
    else seenKey.set(key, id)
  }
  for (const f of files) {
    if (f.source_file_id && byId.has(f.source_file_id)) union(f.source_file_id, f.id)
    link(`book:${(f.book_code ?? f.name).toUpperCase()}`, f.id)
    link(`name:${compact(f.name)}`, f.id)
  }
  const out: FileRow[] = []
  const emitted = new Set<string>()
  for (const f of files) {
    const root = find(f.id)
    if (emitted.has(root)) continue
    emitted.add(root)
    out.push(f)
  }
  return out
}

/** AQU-1468: the files an ask-the-user error offers, as the client's buttons. */
function toCandidates(files: FileRow[]): FileCandidate[] {
  return files.map((f) => ({ id: f.id, name: f.name }))
}

/** A scope failure; `candidates` is set when the agent must ask which file. */
export type ScopeFailure = { ok: false; error: string; candidates?: FileCandidate[] }

function describeFiles(files: FileRow[]): string {
  return files.map((f) => `"${f.name}" (id ${f.id})`).join(", ")
}

/**
 * AQU-1455: let the model name a file the way the user did. Case-insensitive,
 * tried in order: exact, prefix, substring, then edit distance <= 2 against
 * the name's leading characters ("practise1" finds "Practice1_Come_Before_God…").
 * The first tier with any match decides: one match resolves, several return
 * the candidates by exact name, none returns every file the project has.
 */
async function resolveFileByName(
  db: AquillaDb,
  projectId: string,
  query: string,
): Promise<{ ok: true; fileId: string } | ScopeFailure> {
  const documents = groupDocuments(await listCandidateFiles(db, projectId))
  if (documents.length === 0) return { ok: false, error: "this project has no files yet" }
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !NAME_NOISE.has(w))
  const q = words.length > 0 ? words.join("") : compact(query)

  const distanceOf = (n: string) => Math.min(editDistance(q, n.slice(0, q.length)), editDistance(q, n))
  const tiers: Array<(docs: FileRow[]) => FileRow[]> = [
    (docs) => docs.filter((d) => compact(d.name) === q),
    (docs) => docs.filter((d) => compact(d.name).startsWith(q)),
    (docs) => docs.filter((d) => compact(d.name).includes(q)),
    (docs) => {
      // Fuzzy: only the closest names count, so one typo does not tie with a
      // far-off sibling.
      if (q.length < 4) return []
      const scored = docs.map((d) => ({ d, dist: distanceOf(compact(d.name)) })).filter((x) => x.dist <= 2)
      const best = Math.min(...scored.map((x) => x.dist))
      return scored.filter((x) => x.dist === best).map((x) => x.d)
    },
  ]
  for (const tier of tiers) {
    const hits = q ? tier(documents) : []
    if (hits.length === 1) return { ok: true, fileId: hits[0].id }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `"${query}" matches more than one file — ASK THE USER which one, quoting these exact names, and stop. Matches: ${describeFiles(hits)}`,
        candidates: toCandidates(hits),
      }
    }
  }
  return {
    ok: false,
    error: `no file in this project is named like "${query}". The project's files are: ${describeFiles(documents)}. Ask the user which one they mean; do NOT guess a book code.`,
    candidates: toCandidates(documents),
  }
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
): Promise<{ ok: true; fileId: string } | ScopeFailure> {
  const files = await listCandidateFiles(db, projectId)
  if (files.length === 0) return { ok: false, error: "this project has no files yet" }
  const documents = groupDocuments(files)
  if (documents.length === 1) return { ok: true, fileId: documents[0].id }
  return {
    ok: false,
    error:
      "no file is open and this request does not name one — ASK THE USER which file to work in and stop; do NOT pick one yourself, and do NOT try a book code the project may not contain. Files: " +
      describeFiles(documents),
    candidates: toCandidates(documents),
  }
}

/** Resolve {fileId?, ref?} to a concrete file id (+ parsed range). */
export async function resolveScope(
  db: AquillaDb,
  rawArgs: { fileId?: unknown; ref?: unknown },
  ctx: ReadContext,
): Promise<{ ok: true; fileId: string; range?: RefRange; notice?: string } | ScopeFailure> {
  // The model fills an optional argument it has nothing to say for with "" or
  // null. Either names no file and no ref, the same as leaving it out.
  const given = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v)
  const args = { fileId: given(rawArgs.fileId), ref: given(rawArgs.ref) }
  let range: RefRange | undefined
  let refUnparseable = false
  if (args.ref !== undefined) {
    if (typeof args.ref !== "string") return { ok: false, error: "ref must be a string" }
    // AQU-1455: a ref that does not parse is not a dead end. The scope falls
    // back to the file (resolved below, in sequence order) rather than an
    // error that invites the model to try another book code.
    range = parseRefRange(args.ref) ?? undefined
    refUnparseable = range === undefined
  }

  let fileId: string | undefined
  if (args.fileId !== undefined) {
    if (typeof args.fileId !== "string") return { ok: false, error: "fileId must be a string" }
    if (args.fileId === ":file") {
      // AQU-1455: the model reaches for :file even when nothing is open. An
      // unbound :file names no file, so it takes the unfocused path below (one
      // document resolves, several return the candidates) rather than an
      // error that leaves the user with nothing to choose from.
      fileId = ctx.focusedFileId
    } else if (AliasMap.isAlias(args.fileId)) {
      const resolved = ctx.aliases.resolve(args.fileId)
      if (!resolved) return { ok: false, error: `unknown alias ${args.fileId}` }
      fileId = resolved
    } else {
      // A UUID, or any string that is a file's id, is an id; anything else is
      // a file name (AQU-1455).
      const byId = UUID_RE.test(args.fileId)
        ? { id: args.fileId }
        : await db
            .prepare(`SELECT id FROM files WHERE project_id = ? AND id = ? AND deleted_at IS NULL`)
            .bind(ctx.projectId, args.fileId)
            .first<{ id: string }>()
      if (byId) {
        fileId = byId.id
      } else {
        const named = await resolveFileByName(db, ctx.projectId, args.fileId)
        if (!named.ok) return named
        fileId = named.fileId
      }
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
    if (!file) {
      // AQU-1455: the user asked for a book this project does not have. No
      // fallback to the open or only file (AQU-846: they must not get Genesis
      // when they asked for Mark); name what the project does have.
      const documents = groupDocuments(await listCandidateFiles(db, ctx.projectId))
      const codes = [...new Set(documents.map((d) => d.book_code?.toUpperCase()).filter((c): c is string => !!c))]
      return {
        ok: false,
        error:
          `no file with book code ${range.book} in this project. Files: ${describeFiles(documents)}.` +
          (codes.length > 0 ? ` Book codes in this project: ${codes.join(", ")}.` : " These files record no book code.") +
          " ASK THE USER which file they mean, or omit ref and pass that file's name or id to work through it in order.",
        candidates: toCandidates(documents),
      }
    }
    fileId = file.id
  }
  let notice: string | undefined
  if (!fileId) {
    if (ctx.focusedFileId) {
      fileId = ctx.focusedFileId
    } else {
      const unfocused = await resolveUnfocusedScope(db, ctx.projectId)
      if (!unfocused.ok) return unfocused
      fileId = unfocused.fileId
    }
    if (refUnparseable) notice = await refNotice(db, ctx.projectId, fileId, String(args.ref))
  } else if (range) {
    // A known file whose cells never carry this book (a made-up "MRK" on an
    // XXB file): the ref cannot select anything, so the scope is the file.
    const carries = await db
      .prepare(
        `SELECT 1 AS hit FROM cells
         WHERE project_id = ? AND file_id = ? AND side = 'source'
           AND (upper(canonical_ref) LIKE ? OR upper(canonical_ref) LIKE ?)
         LIMIT 1`,
      )
      .bind(ctx.projectId, fileId, `${range.book} %`, `${range.book}:%`)
      .first<{ hit: number }>()
    if (!carries) {
      range = undefined
      notice = await refNotice(db, ctx.projectId, fileId, String(args.ref))
    }
  } else if (refUnparseable) {
    notice = await refNotice(db, ctx.projectId, fileId, String(args.ref))
  }
  return { ok: true, fileId, range, notice }
}

/** AQU-1455: the widening a failed ref causes, in words the model must relay. */
async function refNotice(db: AquillaDb, projectId: string, fileId: string, ref: string): Promise<string> {
  const row = await db
    .prepare(`SELECT name FROM files WHERE project_id = ? AND id = ?`)
    .bind(projectId, fileId)
    .first<{ name: string }>()
  return `notice: ref "${ref}" matched nothing in file "${row?.name ?? fileId}", so the whole file is in scope, in file order. Tell the user this; do not claim you handled "${ref}".`
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
  if (!scope.ok) {
    return {
      ok: false,
      text: `error: ${scope.error}`,
      ...(scope.candidates ? { data: { candidates: scope.candidates } } : {}),
    }
  }

  const filter = typeof args.filter === "string" ? args.filter : "all"
  if (!FILTERS.has(filter)) {
    return { ok: false, text: `error: unknown filter "${filter}" — one of ${[...FILTERS].join(" | ")}` }
  }
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number(args.offset) || 0, 0)

  const all = await selectCellPairs(db, ctx.projectId, { fileId: scope.fileId, range: scope.range, laneId: (await resolveLaneIdOrTag(db, ctx.projectId, ctx.lane)).laneId })
  const filtered = filter === "all" ? all : all.filter((p) => statusOf(p) === filter)
  const page = filtered.slice(offset, offset + limit)

  const notice = scope.notice ? `${scope.notice}\n` : ""

  if (page.length === 0) {
    return {
      ok: true,
      text: `${notice}0 of ${all.length} cells match (filter: ${filter}${scope.range ? `, ref scope` : ""}).`,
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
    text: notice + lines.join("\n"),
    data: { cells: page.map((p) => pairToRow(p, scope.fileId)) },
  }
}
