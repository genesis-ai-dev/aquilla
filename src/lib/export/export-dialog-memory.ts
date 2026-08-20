// What the export dialog was set to last time, per project and per user.
// (AQU-646, 2026-08-20)
//
// Sam: "let's make this Export dialog state being remembered per project but
// also per user." Both halves matter. A dubbing project is worked one way —
// audio, by character, every time — and a translation project another, so one
// global memory would fight itself; and two people sharing a machine should
// not inherit each other's last click.
//
// Shape and storage discipline copied from `lib/frontier/last-location-store.ts`:
// a single versioned key holding an LRU array keyed by (user, project), every
// read and write wrapped, and a cap so a machine with a hundred projects on it
// does not grow the entry without bound.
//
// EVERY FIELD IS VALIDATED ON READ, against the live lists rather than against
// what was stored. Format ids and section names come and go — `character-sheets`
// and `project-report` did not exist a week ago — so a value from an older
// build has to fall back to the default rather than select a format that is no
// longer offered, or open a section that no longer renders.

const STORAGE_KEY = "aq.exportdlg.v1"
const MAX_ENTRIES = 50

/** Which of the three sections is open. `null` is all-collapsed, which is what
 *  a first-ever open looks like. */
export type ExportSection = "audio" | "subtitle" | "fold"

/** Which file the subtitle section exports: the subtitle rows, or the audio
 *  cues that were imported beside them. */
export type SubtitleTarget = "subtitle" | "audio"

export interface ExportDialogMemory {
  section: ExportSection | null
  audioMode: "audio-by-character" | "audio-by-line"
  subtitleTarget: SubtitleTarget
  /** The chosen format inside the third section. */
  foldFormat: string | null
  cueSplitting: boolean
  excludeLabels: boolean
  includeSource: boolean
}

export const DEFAULT_EXPORT_MEMORY: ExportDialogMemory = {
  section: null,
  audioMode: "audio-by-character",
  subtitleTarget: "subtitle",
  foldFormat: null,
  cueSplitting: false,
  excludeLabels: false,
  includeSource: false,
}

interface Entry {
  userId: string
  projectId: string
  state: ExportDialogMemory
}

const SECTIONS: readonly ExportSection[] = ["audio", "subtitle", "fold"]
const AUDIO_MODES: readonly ExportDialogMemory["audioMode"][] = [
  "audio-by-character",
  "audio-by-line",
]
const TARGETS: readonly SubtitleTarget[] = ["subtitle", "audio"]

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/**
 * A stored blob turned into something safe to render from.
 *
 * Exported for its own tests: this is the function standing between a stale or
 * hand-edited localStorage value and the dialog's state, and every field it
 * lets through unchecked is a way for the dialog to open in a state it cannot
 * actually be in.
 */
export function normalizeExportMemory(raw: unknown): ExportDialogMemory {
  if (!raw || typeof raw !== "object") return DEFAULT_EXPORT_MEMORY
  const v = raw as Record<string, unknown>
  return {
    // An unrecognised section collapses everything rather than falling back to
    // a real one. A stale value naming a section that no longer exists says
    // nothing about which of the current three the person wanted, and opening
    // one on that basis is a guess dressed as a memory.
    section: SECTIONS.includes(v.section as ExportSection) ? (v.section as ExportSection) : null,
    audioMode: oneOf(v.audioMode, AUDIO_MODES, DEFAULT_EXPORT_MEMORY.audioMode),
    subtitleTarget: oneOf(v.subtitleTarget, TARGETS, DEFAULT_EXPORT_MEMORY.subtitleTarget),
    // NOT validated against a list here — the format ids live in the dialog and
    // change with the file type. The caller checks it against what it is
    // actually offering, which is the only place that knows.
    foldFormat: typeof v.foldFormat === "string" ? v.foldFormat : null,
    cueSplitting: bool(v.cueSplitting, false),
    excludeLabels: bool(v.excludeLabels, false),
    includeSource: bool(v.includeSource, false),
  }
}

function readAll(): Entry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Entry[]) : []
  } catch {
    return []
  }
}

function writeAll(entries: Entry[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage full / disabled — non-fatal, the dialog just opens fresh.
  }
}

/** What this user last chose in this project, or the defaults. Never throws and
 *  never returns a half-valid object — see `normalizeExportMemory`. */
export function readExportMemory(userId: string, projectId: string): ExportDialogMemory {
  const found = readAll().find((e) => e.userId === userId && e.projectId === projectId)
  return found ? normalizeExportMemory(found.state) : DEFAULT_EXPORT_MEMORY
}

/** Remember this user's choices in this project, promoted to the front of the
 *  LRU list. */
export function writeExportMemory(
  userId: string,
  projectId: string,
  state: ExportDialogMemory,
): void {
  const entries = readAll()
  const filtered = entries.filter((e) => !(e.userId === userId && e.projectId === projectId))
  writeAll([{ userId, projectId, state }, ...filtered].slice(0, MAX_ENTRIES))
}
