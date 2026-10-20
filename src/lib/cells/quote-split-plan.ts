// AQU-1759: the events that split rows at their quotation marks.
//
// THE SHAPE, and why it is this one. The row being split KEEPS its id and
// becomes the first piece; every later piece is a new row inserted after it.
// Keeping the id is what keeps everything hanging off the row — its comments,
// recordings, validations, voice and every language's translation — attached
// to something, instead of deleting the row and re-creating its parts, which
// would orphan all of it. It is also the shape the Agent API's SplitCell
// already writes (sync-worker structure-engine), and the shape the exporters
// already understand: a piece carries NO verse reference and the `user-insert`
// origin marker, so the USFM export (and its source-side twin) appends it
// inside the verse it follows — the verse goes back out whole.
//
// Per split row, in this order:
//   1. `source.cell.commit` on the row itself — its text becomes piece one;
//   2. one `source.cell.create` per later piece, each anchored on the piece
//      before it;
//   3. after every row's own events, one `source.cell.reorder` moving whatever
//      followed the row onto its LAST piece. Last, because the follower may be
//      a row split in the same plan, and its reorder must then chain on its own
//      commit from step 1 — two events claiming the same parent is a stale
//      sibling the server drops.
//
// TRANSLATIONS (Sam's brief: never silently lose a translator's text). The
// pieces exist in every language at once, because rows are shared by all of
// them — that is how a second language reuses the split. Each language's
// existing translation of the row is then either:
//   - DIVIDED, when it splits at its own quotation marks into the same number
//     of pieces with narration and speech in the same places. Each piece gets
//     its part, pinned to the new source so nothing reads as stale; or
//   - KEPT whole on the first piece, untouched, in every other case. The
//     source under it changed, so AD-9 flags it for review — which is exactly
//     what a translator needs to see: "move the quoted part to the rows below".
// Nothing is ever deleted or rewritten on a guess.

import type { CellRow } from "@/lib/sync/cells-read-types"
import type { BuildEventInput } from "@/lib/sync/events-emit"
import type { OutboxEventKind } from "@/lib/sync/outbox-types"
import { splitLineOrigin } from "@/lib/timeline/user-line-origin"
import { splitAtQuotes, type QuoteSplitPiece } from "./quote-split"

/** Why a row cannot be split, when it cannot. */
export type QuoteSplitRowRefusal =
  /** No quotation, or one speaker throughout. */
  | "single"
  /** A seam would cut USFM markup in half. */
  | "markup"
  /** The source is formatted HTML; this cuts plain text only. */
  | "formatted"

/**
 * HTML that says nothing the plain text does not: paragraph wrappers and line
 * breaks. Anything else (a footnote, a style, a link) would be lost by writing
 * the plain pieces, so it refuses.
 */
export function isPlainHtml(html: string | null | undefined): boolean {
  if (!html) return true
  return !/</.test(html.replace(/<\/?p>|<br\s*\/?>/gi, ""))
}

/** Can this row's source be split, and into what? */
export function quoteSplitForRow(
  source: { value: string; valueHtml?: string | null },
): { pieces: QuoteSplitPiece[]; refusal: QuoteSplitRowRefusal | null } {
  const split = splitAtQuotes(source.value)
  if (split.pieces.length < 2) return { pieces: split.pieces, refusal: "single" }
  if (!isPlainHtml(source.valueHtml)) return { pieces: split.pieces, refusal: "formatted" }
  if (split.refusal) return { pieces: split.pieces, refusal: split.refusal }
  return { pieces: split.pieces, refusal: null }
}

export interface QuoteSplitRowInput {
  /** The row's source, fresh from the server (its `eventId` is the chain head
   *  the commit chains on). */
  source: CellRow
  /** Every language's translation of the row the reader may see. */
  targets: readonly CellRow[]
  /** The row anchored to this one, which moves onto the last piece. */
  successor: { cellId: string; eventId: string } | null
  /** The order key of the row displayed after this one, so the new pieces can
   *  be numbered between the two without renumbering anything. */
  nextSequenceIndex?: number
}

export interface PlannedQuoteSplit {
  cellId: string
  pieces: QuoteSplitPiece[]
  /** Ids of pieces two onward, in order. */
  newCellIds: string[]
  /** Their order keys, aligned with `newCellIds` (absent on an unordered file). */
  sequenceIndexes: Array<number | undefined>
  /** New pieces of the same kind as the first — narration after narration —
   *  which keep the row's voice. The others are left for casting. */
  sameKindAsFirst: string[]
  successorCellId: string | null
  /** What happened to each language's translation of the row. */
  lanes: Array<{ targetLang: string; outcome: "divided" | "kept" }>
}

type SplitEventKind = Extract<
  OutboxEventKind,
  "source.cell.commit" | "source.cell.create" | "source.cell.reorder" | "target.cell.commit"
>

export interface QuoteSplitPlan {
  splits: PlannedQuoteSplit[]
  /** Rows that were asked for and refused, with the reason. */
  refused: Array<{ cellId: string; refusal: QuoteSplitRowRefusal | "unsaved" }>
  /** Every event, in the order they must be sent. */
  events: BuildEventInput<SplitEventKind>[]
}

/** The order keys for `count` new rows between `before` and `after`. */
function sequenceRun(before: number | undefined, after: number | undefined, count: number): Array<number | undefined> {
  if (before == null) return Array.from({ length: count }, () => undefined)
  if (after == null || after <= before) return Array.from({ length: count }, (_, i) => before + i + 1)
  const step = (after - before) / (count + 1)
  return Array.from({ length: count }, (_, i) => before + step * (i + 1))
}

/** Same pieces, narration and speech in the same places. */
function sameShape(a: readonly QuoteSplitPiece[], b: readonly QuoteSplitPiece[]): boolean {
  return a.length === b.length && a.every((piece, i) => piece.kind === b[i].kind)
}

export function planQuoteSplits(input: {
  projectId: string
  fileId: string
  author: string
  rows: readonly QuoteSplitRowInput[]
  /** Mints ids for new cells and events (uuidv7 in the app). */
  mintId: () => string
}): QuoteSplitPlan {
  const { projectId, fileId, author, mintId } = input
  const splits: PlannedQuoteSplit[] = []
  const refused: QuoteSplitPlan["refused"] = []
  const rowEvents: BuildEventInput<SplitEventKind>[] = []
  const reorders: BuildEventInput<SplitEventKind>[] = []
  const targetEvents: BuildEventInput<SplitEventKind>[] = []
  /** cellId → the id of its own source commit in this plan. */
  const commitIdByCell = new Map<string, string>()
  const lastPieceByCell = new Map<string, string>()

  const accepted: Array<{ row: QuoteSplitRowInput; split: PlannedQuoteSplit; createIds: string[] }> = []
  for (const row of input.rows) {
    const { source } = row
    // Not yet confirmed by the server: there is no head to chain on. The same
    // window `getRemovalPlan` refuses a removal in.
    if (!source.eventId) {
      refused.push({ cellId: source.cellId, refusal: "unsaved" })
      continue
    }
    const { pieces, refusal } = quoteSplitForRow(source)
    if (refusal) {
      refused.push({ cellId: source.cellId, refusal })
      continue
    }
    const newCellIds = pieces.slice(1).map(() => mintId())
    const createIds = newCellIds.map(() => mintId())
    const commitId = mintId()
    commitIdByCell.set(source.cellId, commitId)
    lastPieceByCell.set(source.cellId, newCellIds[newCellIds.length - 1])
    const sequenceIndexes = sequenceRun(source.sequenceIndex ?? undefined, row.nextSequenceIndex, newCellIds.length)

    rowEvents.push({
      id: commitId,
      kind: "source.cell.commit",
      projectId,
      fileId,
      cellId: source.cellId,
      parentId: source.eventId,
      author,
      payload: { value: pieces[0].text },
    })
    newCellIds.forEach((cellId, i) => {
      const sequenceIndex = sequenceIndexes[i]
      rowEvents.push({
        id: createIds[i],
        kind: "source.cell.create",
        projectId,
        fileId,
        cellId,
        parentId: null,
        author,
        payload: {
          cellId,
          anchorCellId: i === 0 ? source.cellId : newCellIds[i - 1],
          value: pieces[i + 1].text,
          ...(source.type ? { type: source.type } : {}),
          ...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
          metadata: { aquillaOrigin: splitLineOrigin(source.cellId) },
        },
      })
    })

    const split: PlannedQuoteSplit = {
      cellId: source.cellId,
      pieces,
      newCellIds,
      sequenceIndexes,
      sameKindAsFirst: newCellIds.filter((_, i) => pieces[i + 1].kind === pieces[0].kind),
      successorCellId: row.successor?.cellId ?? null,
      lanes: [],
    }
    splits.push(split)
    accepted.push({ row, split, createIds })
  }

  for (const { row, split, createIds } of accepted) {
    if (row.successor) {
      reorders.push({
        kind: "source.cell.reorder",
        projectId,
        fileId,
        cellId: row.successor.cellId,
        // A follower split in this same plan has already moved its own head.
        parentId: commitIdByCell.get(row.successor.cellId) ?? row.successor.eventId,
        author,
        payload: { anchorCellId: lastPieceByCell.get(split.cellId)! },
      })
    }

    const commitId = commitIdByCell.get(split.cellId)!
    for (const target of row.targets) {
      if (!target.value.trim()) continue
      const targetLang = target.targetLang ?? ""
      const lane = {
        ...(targetLang ? { targetLang } : {}),
        ...(target.laneId ? { laneId: target.laneId } : {}),
      }
      const own = splitAtQuotes(target.value)
      const divisible =
        isPlainHtml(target.valueHtml) && own.refusal === null && sameShape(own.pieces, split.pieces)
      split.lanes.push({ targetLang, outcome: divisible ? "divided" : "kept" })
      if (!divisible) continue
      targetEvents.push({
        kind: "target.cell.commit",
        projectId,
        fileId,
        cellId: split.cellId,
        parentId: target.eventId,
        author,
        payload: { value: own.pieces[0].text, sourceEventId: commitId, ...lane },
      })
      split.newCellIds.forEach((cellId, i) => {
        targetEvents.push({
          kind: "target.cell.commit",
          projectId,
          fileId,
          cellId,
          // A row's first translation chains on its source create, as every
          // first commit does (see `getCommitHandle`).
          parentId: createIds[i],
          author,
          payload: { value: own.pieces[i + 1].text, sourceEventId: createIds[i], ...lane },
        })
      })
    }
  }

  return { splits, refused, events: [...rowEvents, ...reorders, ...targetEvents] }
}

/**
 * The voice assignments a split adds: each new piece of the same kind as the
 * first — narration after narration — takes the voice the row was cast in, so
 * splitting never recasts the narrator. Quotation pieces get nothing, and so
 * read in the project's default voice until someone casts them; that is the
 * point of the split. Null when there is nothing to add (the row had no voice
 * of its own, so its pieces fall back to the same default anyway).
 */
export function voiceAssignmentsForSplits(
  splits: readonly Pick<PlannedQuoteSplit, "cellId" | "sameKindAsFirst">[],
  castAssignments: Readonly<Record<string, string>> | undefined,
): Record<string, string> | null {
  const added: Record<string, string> = {}
  for (const split of splits) {
    const voiceId = castAssignments?.[split.cellId]
    if (!voiceId) continue
    for (const cellId of split.sameKindAsFirst) added[cellId] = voiceId
  }
  return Object.keys(added).length > 0 ? added : null
}

/**
 * The rows of a file that "Split all lines at quotes" would split, and how many
 * lines they would become — the count its confirmation promises. The caller
 * leaves out rows the row action refuses for reasons other than their text
 * (audio, IDML, parked rows); this asks only what the text says.
 */
export function quoteSplitCandidates(
  cells: Iterable<{ id: string; original?: string | null; originalHtml?: string | null }>,
): { cellIds: string[]; lines: number } {
  const cellIds: string[] = []
  let lines = 0
  for (const cell of cells) {
    const { pieces, refusal } = quoteSplitForRow({ value: cell.original ?? "", valueHtml: cell.originalHtml })
    if (refusal) continue
    cellIds.push(cell.id)
    lines += pieces.length
  }
  return { cellIds, lines }
}
