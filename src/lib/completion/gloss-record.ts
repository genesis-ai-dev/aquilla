/**
 * The statistical gloss of record — the project's own word-for-word reading of
 * a translated cell, as a contributor has corrected it (AQU-1408 §1).
 *
 * The gloss itself is computed in the browser from the project's translated
 * pairs, so it is only as good as the pairs that exist: Biblica's reviewers saw
 * it go wrong on books nobody has validated yet and had nowhere to put the
 * correction. A record here IS that correction. It takes precedence over the
 * computed gloss wherever the cell is read, and §2 feeds it back as a seed so
 * the correction spreads to every other cell using the same words.
 *
 * Pinning mirrors `bt-record.ts`: the server pins the row to `targetEventId`,
 * the client also stores `forText` (the exact target string that was glossed)
 * so an unsaved draft or event-id lag cannot present a correction of older text
 * as a correction of what is on screen.
 */

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"

export interface GlossRecord {
  cellId: string
  /** The corrected gloss. Empty means the correction was withdrawn. */
  glossText: string
  /** Target commit this gloss reads. Empty when unknown. */
  targetEventId: string
  /**
   * Exact target text this gloss describes. Empty only for server-hydrated
   * rows whose pin we have not yet compared to the live cell.
   */
  forText: string
  author?: string
  createdAt: number
}

/**
 * The gloss a cell actually shows, and whether it is a human correction.
 * `corrected` drives the UI's "edited" marker — a reader who cannot tell the
 * corpus's own guess from a colleague's correction cannot weigh either.
 */
export interface GlossReading {
  text: string
  corrected: boolean
}

export const EMPTY_GLOSS_READING: GlossReading = { text: "", corrected: false }

const LS_PREFIX = "gloss:"

/** Query string for the glosses read. Absent lane is the default lane. */
export function glossesReadQuery(lane: string): string {
  return lane ? `?lane=${encodeURIComponent(lane)}` : ""
}

function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, " ")
}

/**
 * The gloss to show for a cell: the contributor's correction when it still
 * describes the text on screen, the computed gloss otherwise.
 *
 * Deliberately falls back rather than showing a stale correction with a
 * warning. A gloss is a reading of specific words; once those words change it
 * is not a weaker reading of the new ones, it is a reading of something else.
 * The AI back-translation can afford "stale, refresh?" because regenerating it
 * costs a model call — recomputing a gloss costs nothing.
 */
export function resolveGloss(args: {
  record: GlossRecord | undefined
  computed: string
  visibleTranslated: string
  committedTargetEventId?: string
}): GlossReading {
  const { record, computed, visibleTranslated, committedTargetEventId } = args
  const corrected = record?.glossText.trim() ?? ""
  if (!corrected) return { text: computed, corrected: false }

  const described = record?.forText
    || (record?.targetEventId
      && committedTargetEventId
      && record.targetEventId === committedTargetEventId
      ? visibleTranslated
      : "")

  if (described) {
    return collapseWs(described) === collapseWs(visibleTranslated)
      ? { text: corrected, corrected: true }
      : { text: computed, corrected: false }
  }

  // Server row with no forText: trust the pin when both sides have one.
  if (record?.targetEventId && committedTargetEventId) {
    return record.targetEventId === committedTargetEventId
      ? { text: corrected, corrected: true }
      : { text: computed, corrected: false }
  }
  return { text: computed, corrected: false }
}

export function glossLocalStorageKey(projectId: string, cellId: string, lane = ""): string {
  const lanePart = lane ? `${encodeURIComponent(lane)}:` : ""
  return ownerScopedLocalStorageKey(`${LS_PREFIX}${projectId}:${lanePart}${cellId}`)
}

export function readLocalGloss(
  projectId: string,
  cellId: string,
  lane = "",
): GlossRecord | undefined {
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(glossLocalStorageKey(projectId, cellId, lane))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<GlossRecord>
    if (typeof parsed.glossText !== "string") return undefined
    return {
      cellId,
      glossText: parsed.glossText,
      targetEventId: parsed.targetEventId ?? "",
      forText: parsed.forText ?? "",
      author: parsed.author,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    }
  } catch {
    return undefined
  }
}

export function writeLocalGloss(
  projectId: string,
  record: GlossRecord,
  lane = "",
): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(glossLocalStorageKey(projectId, record.cellId, lane), JSON.stringify(record))
  } catch {
    // quota / private browsing — the in-memory cache still holds the correction
  }
}

export function glossRecordFromHydrationRow(row: {
  cellId: string
  targetEventId: string
  glossText: string
  author: string
  createdAt: number
}): GlossRecord {
  return {
    cellId: row.cellId,
    glossText: row.glossText,
    targetEventId: row.targetEventId,
    forText: "",
    author: row.author,
    createdAt: row.createdAt,
  }
}
