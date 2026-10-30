// The Station's History box (AQU-2327, spec item 30): the open recording's
// story, from the line's server history (cell-history-read-route) and the
// unsaved edits, worded as the working build (board 40b) words them. Q12:
// each row also says who did it and when.

import type { CellHistoryEvent } from "@/lib/sync/history-read-types"
import type { EditOp } from "./edit-list"
import { formatStationLength, formatStationTime } from "./time"

export interface HistoryRow {
  /** An `editor.station.*` key, and its values. */
  key: string
  params?: Record<string, string | number>
  who?: string
  at?: number
}

type Payload = {
  audioId?: string | null
  referenceAudioId?: string
  trimStartMs?: number | null
  trimEndMs?: number | null
  label?: string | null
  atMs?: number
}

/**
 * The rows for one recording: `ids` is the open take and the versions it was
 * made from (its `referenceAudioId` chain), oldest event first. A trim to the
 * recording's edge names the edge's time from `durationSec`.
 */
export function historyRowsFromEvents(
  events: readonly CellHistoryEvent[],
  ids: ReadonlySet<string>,
  opts: { durationSec?: number | null; versionOf?(audioId: string): number } = {},
): HistoryRow[] {
  const rows: HistoryRow[] = []
  const ordered = [...events].sort((a, b) => a.serverSeq - b.serverSeq)
  for (const ev of ordered) {
    const p = (ev.payload ?? {}) as Payload
    if (!p.audioId || !ids.has(p.audioId)) continue
    const who = { who: ev.author, at: ev.serverTs || ev.clientTs }
    switch (ev.kind) {
      case "cell.audio.attach":
        if (p.referenceAudioId && ids.has(p.referenceAudioId)) {
          rows.push({ key: "editor.station.hVersionSaved", params: { n: opts.versionOf?.(p.audioId) ?? 2 }, ...who })
        } else rows.push({ key: "editor.station.hRecorded", ...who })
        break
      case "cell.audio.trim": {
        const end = p.trimEndMs != null ? p.trimEndMs / 1000 : (opts.durationSec ?? null)
        rows.push({
          key: "editor.station.hTrimmed",
          params: { a: formatStationTime((p.trimStartMs ?? 0) / 1000), b: end != null ? formatStationTime(end) : "—" },
          ...who,
        })
        break
      }
      case "cell.audio.validate":
        rows.push({ key: "editor.station.hApproved", ...who })
        break
      case "cell.audio.unvalidate":
        rows.push({ key: "editor.station.hUnapproved", ...who })
        break
      case "cell.audio.rename":
        if (p.label) rows.push({ key: "editor.station.hRenamed", params: { name: p.label }, ...who })
        break
      case "cell.audio.place":
        rows.push({ key: "editor.station.hMoved", ...who })
        break
      case "cell.audio.cut":
        rows.push({ key: "editor.station.hSplit", params: { time: formatStationTime((p.atMs ?? 0) / 1000) }, ...who })
        break
      case "cell.audio.select":
        rows.push({ key: "editor.station.hChosen", ...who })
        break
      case "cell.audio.remove":
        rows.push({ key: "editor.station.hDeleted", ...who })
        break
      default:
        break
    }
  }
  return rows
}

/** The unsaved edits, numbered as 40b numbers them ("1. Deleted 0.50 s at 0:01.00 · not saved yet"). */
export function draftRows(ops: readonly EditOp[]): HistoryRow[] {
  return ops.map((op, i) =>
    op.kind === "del"
      ? { key: "editor.station.hDraftDeleted", params: { n: i + 1, len: formatStationLength(op.b - op.a), time: formatStationTime(op.a) } }
      : { key: "editor.station.hDraftInserted", params: { n: i + 1, label: op.label, len: formatStationLength(op.len), time: formatStationTime(op.at) } },
  )
}

/** "2:14 pm" today, "Oct 28, 2:14 pm" before (Q12). */
export function historyWhen(at: number, locale: string, now = Date.now()): string {
  const d = new Date(at)
  const same = new Date(now).toDateString() === d.toDateString()
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d)
  if (same) return time
  return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d)}, ${time}`
}
