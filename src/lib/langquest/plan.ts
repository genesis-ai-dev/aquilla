// What a LangQuest sync has to do, worked out without touching the network.
//
// LangQuest has no projects or text: a language holds passages, each with a
// label, a place in a book (`path`), an optional verse reference, and versions
// made of ordered audio cards. In Aquilla one linked language is one project:
//   • each book (the passage's first `path` label) is a file;
//   • each passage is a source cell whose value is its label;
//   • each new version is ONE dub take — its first card the take, every later
//     card a piece of it (`pieceOf`, AQU-1767), so the cards play in order.
//
// Ids are deterministic (UUIDv5 under LANGQUEST_NS), like the Door43 importer's
// (src/lib/dcs/cell-id.ts): a sync that dies halfway and runs again derives the
// same file, cell and event ids, and the server's event-id dedupe turns the
// repeat into a no-op instead of a second copy.

import { v5 as uuidv5 } from "uuid"
import type { KnownPassage, LangQuestAudioCard, LangQuestPassage } from "./types"

/** NEVER CHANGE: every LangQuest file, cell and event id derives from it. */
export const LANGQUEST_NS = "0b8f0f5e-6f43-4c39-9b55-6c3c7b1d2a91"

export const langquestFileId = (projectId: string, languageId: string, book: string): string =>
  uuidv5(`${projectId}|${languageId}|file|${book}`, LANGQUEST_NS)

/** Cells are keyed by project already, so the cell id need not carry it. */
export const langquestCellId = (languageId: string, unitId: string): string =>
  uuidv5(`${languageId}|cell|${unitId}`, LANGQUEST_NS)

export const langquestEventId = (projectId: string, ...parts: string[]): string =>
  uuidv5(`${projectId}|${parts.join("|")}`, LANGQUEST_NS)

/** Deterministic audio id for one card in one cell; content-addressed by LangQuest's hash. */
export const langquestAudioId = (cellId: string, card: Pick<LangQuestAudioCard, "hash">): string =>
  `lq-${cellId.slice(0, 8)}-${card.hash.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`

/** The book a passage files under: its outermost path label, else its reference's book. */
export function bookOf(p: Pick<LangQuestPassage, "path" | "reference">): string {
  return p.path[0]?.trim() || p.reference?.book || "Passages"
}

/** `GEN 1:1` for a single verse; ranges and whole chapters get none (see metadata instead). */
export function canonicalRefOf(p: Pick<LangQuestPassage, "reference">): string | undefined {
  const r = p.reference
  if (!r || r.chapter == null || r.verse == null) return undefined
  const single = (r.endChapter == null || r.endChapter === r.chapter) && (r.endVerse == null || r.endVerse === r.verse)
  return single ? `${r.book} ${r.chapter}:${r.verse}` : undefined
}

export interface PlannedCell {
  unitId: string
  cellId: string
  /** source.cell.create event id. */
  eventId: string
  /** The cell this one follows in its file; null for a file's first cell. */
  anchorCellId: string | null
  value: string
  order: string
  canonicalRef?: string
  metadata: Record<string, unknown>
}

export interface PlannedFile {
  fileId: string
  name: string
  cells: PlannedCell[]
}

export interface PlannedTake {
  unitId: string
  fileId: string
  cellId: string
  takeId: string
  versionN: number
  cards: LangQuestAudioCard[]
}

export interface SyncPlan {
  /** Books Aquilla has no file for yet: created with their cells in one import. */
  newFiles: PlannedFile[]
  /** Passages new to a book that already has a file. */
  newCells: (PlannedCell & { fileId: string })[]
  /** A version Aquilla has not attached yet, with its audio. */
  takes: PlannedTake[]
  /** Passages LangQuest no longer lists (hidden, or the book re-divided). */
  removed: KnownPassage[]
  /** The map rows to record once the plan has landed. */
  rows: KnownPassage[]
}

/**
 * Diff what LangQuest says now against what this project imported.
 *
 * `passages` are the passages read in this sync (every passage on a full
 * listing; the changed ones otherwise). `deletedUnitIds` are the feed's
 * `unit.deleted` changes — and, on a full listing, every known unit the
 * listing no longer has.
 */
export function planSync(args: {
  projectId: string
  languageId: string
  known: KnownPassage[]
  passages: LangQuestPassage[]
  deletedUnitIds: string[]
}): SyncPlan {
  const { projectId, languageId } = args
  const known = new Map(args.known.map((k) => [k.unitId, k]))
  const knownFileIds = new Set(args.known.map((k) => k.fileId))
  const deleted = new Set(args.deletedUnitIds)

  const plan: SyncPlan = { newFiles: [], newCells: [], takes: [], removed: [], rows: [] }
  const newFiles = new Map<string, PlannedFile>()
  // Passages in display order, so each new cell can anchor on the one before.
  const ordered = [...args.passages]
    .filter((p) => !deleted.has(p.unitId))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))

  for (const p of ordered) {
    const prior = known.get(p.unitId)
    const book = bookOf(p)
    const fileId = prior?.fileId ?? langquestFileId(projectId, languageId, book)
    const cellId = prior?.cellId ?? langquestCellId(languageId, p.unitId)

    if (!prior) {
      const cell: PlannedCell = {
        unitId: p.unitId,
        cellId,
        eventId: langquestEventId(projectId, p.unitId, "create"),
        anchorCellId: null,
        value: p.label,
        order: p.order,
        ...(canonicalRefOf(p) ? { canonicalRef: canonicalRefOf(p) } : {}),
        metadata: { langquest: { unitId: p.unitId, path: p.path, reference: p.reference, kind: p.kind } },
      }
      if (knownFileIds.has(fileId)) {
        cell.anchorCellId = anchorFor(p.order, fileId, args.known, plan.newCells)
        plan.newCells.push({ ...cell, fileId })
      } else {
        let file = newFiles.get(fileId)
        if (!file) {
          file = { fileId, name: book, cells: [] }
          newFiles.set(fileId, file)
        }
        cell.anchorCellId = file.cells.at(-1)?.cellId ?? null
        file.cells.push(cell)
      }
    }

    const version = p.version
    const audio = p.audio ?? []
    const takeId = version && audio.length > 0 && version.takeId !== prior?.takeId ? version.takeId : null
    if (takeId && version) {
      plan.takes.push({ unitId: p.unitId, fileId, cellId, takeId, versionN: version.n, cards: audio })
    }
    plan.rows.push({
      unitId: p.unitId,
      fileId,
      cellId,
      label: p.label,
      order: p.order,
      takeId: takeId ?? prior?.takeId ?? null,
    })
  }
  plan.newFiles = [...newFiles.values()]
  for (const unitId of deleted) {
    const prior = known.get(unitId)
    if (prior) plan.removed.push(prior)
  }
  return plan
}

/**
 * The last cell in `fileId` that sorts before `order`, among known and
 * just-planned cells. Known limit: cells order by an anchor chain whose
 * siblings tiebreak by event id, so a passage LangQuest inserts in the MIDDLE
 * of a book can land after the cell that already followed its anchor. Units
 * come from templates, so mid-book inserts are rare; appends order correctly.
 */
function anchorFor(
  order: string,
  fileId: string,
  known: KnownPassage[],
  planned: (PlannedCell & { fileId: string })[],
): string | null {
  let best: { order: string; cellId: string } | null = null
  for (const c of [...known, ...planned]) {
    if (c.fileId !== fileId || c.order >= order) continue
    if (!best || c.order > best.order) best = { order: c.order, cellId: c.cellId }
  }
  return best?.cellId ?? null
}
