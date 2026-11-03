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
  gainDb?: number | null
  fadeInMs?: number | null
  fadeOutMs?: number | null
  /** AQU-2327: a Station version's changes and lines (cell ids), and whether
   *  it was saved over the take. */
  versionChanges?: { kinds?: string[]; usedOn?: string[]; over?: boolean }
}

/** How History words a version's changes and lines (the panel supplies it). */
export interface VersionWording {
  kinds(kinds: readonly string[]): string
  lines(cellIds: readonly string[]): string
}

/**
 * The rows for one recording: `ids` is the open take and the versions it was
 * made from (its `referenceAudioId` chain), oldest event first. A trim to the
 * recording's edge names the edge's time from that version's own length
 * (`durationOf`), or `durationSec` when it isn't known.
 */
export function historyRowsFromEvents(
  events: readonly CellHistoryEvent[],
  ids: ReadonlySet<string>,
  opts: {
    durationSec?: number | null
    durationOf?(audioId: string): number | null
    versionOf?(audioId: string): number
    /** Words a saved version's changes and lines; without it, or without the
     *  details on the event (a version saved before they were recorded), the
     *  row is "Version 2 saved". */
    wording?: VersionWording
  } = {},
): HistoryRow[] {
  const rows: HistoryRow[] = []
  const ordered = [...events].sort((a, b) => a.serverSeq - b.serverSeq)
  // A take saved over is removed in the same step: its "Saved over" row says
  // so, and no "Deleted" row follows it.
  const savedOver = new Set<string>()
  for (const ev of ordered) {
    const p = (ev.payload ?? {}) as Payload
    if (ev.kind === "cell.audio.attach" && p.versionChanges?.over && p.referenceAudioId) savedOver.add(p.referenceAudioId)
  }
  for (const ev of ordered) {
    const p = (ev.payload ?? {}) as Payload
    if (!p.audioId || !ids.has(p.audioId)) continue
    const who = { who: ev.author, at: ev.serverTs || ev.clientTs }
    switch (ev.kind) {
      case "cell.audio.attach":
        if (p.referenceAudioId && ids.has(p.referenceAudioId)) {
          // Item 30 (40b): "Version 2 saved: a part deleted, audio inserted ·
          // used on line 331", when the save recorded what and where.
          const n = opts.versionOf?.(p.audioId) ?? 2
          const vc = p.versionChanges
          const what = opts.wording && vc?.kinds?.length ? opts.wording.kinds(vc.kinds) : ""
          const lines = opts.wording && vc?.usedOn?.length ? opts.wording.lines(vc.usedOn) : ""
          if (vc?.over) {
            // Sam, Nov 2: "Save" saves over the take, which keeps its name.
            rows.push(
              what && lines
                ? { key: "editor.station.hSavedOverWith", params: { what, lines }, ...who }
                : { key: "editor.station.hSavedOver", ...who },
            )
            break
          }
          rows.push(
            what && lines
              ? { key: "editor.station.hVersionSavedWith", params: { n, what, lines }, ...who }
              : { key: "editor.station.hVersionSaved", params: { n }, ...who },
          )
        } else rows.push({ key: "editor.station.hRecorded", ...who })
        break
      case "cell.audio.trim": {
        // An open end is THAT version's edge: an earlier version's trim must
        // not read the open version's length (found in the browser walk:
        // "End 0:04.30" on a 4.20 s take, after a 4.30 s version was saved).
        const edge = opts.durationOf?.(p.audioId) ?? opts.durationSec ?? null
        const end = p.trimEndMs != null ? p.trimEndMs / 1000 : edge
        rows.push({
          key: "editor.station.hTrimmed",
          params: { a: formatStationTime((p.trimStartMs ?? 0) / 1000), b: end != null ? formatStationTime(end) : "—" },
          ...who,
        })
        break
      }
      case "cell.audio.gain":
        rows.push({
          key: "editor.station.hLevel",
          params: {
            db: `${(p.gainDb ?? 0) > 0 ? "+" : (p.gainDb ?? 0) < 0 ? "−" : ""}${Math.abs(p.gainDb ?? 0)} dB`,
            fin: formatStationLength((p.fadeInMs ?? 0) / 1000),
            fout: formatStationLength((p.fadeOutMs ?? 0) / 1000),
          },
          ...who,
        })
        break
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
        if (!savedOver.has(p.audioId)) rows.push({ key: "editor.station.hDeleted", ...who })
        break
      default:
        break
    }
  }
  return rows
}

/** The unsaved edits, numbered as 40b numbers them ("1. Deleted 0.50 s at 0:01.00 · not saved yet"). */
export function draftRows(ops: readonly EditOp[]): HistoryRow[] {
  return ops.map((op, i): HistoryRow =>
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
