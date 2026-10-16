/**
 * Smart Extensions bridge, apiRev 4 — the last built-in editor surfaces an
 * `editor` extension reaches: per-take audio validation, the Audio lens's
 * take (waveform peaks, trim, voice, cloning), source editing and the cell
 * menu (scope write:source), the AI surfaces next to a cell (translation-
 * memory examples, contextual autopilot drafts, smart edits), and the source
 * selection toolbar (view / add term, Ask AI). Host computes, frame renders;
 * anything with its own host UI (term popovers, clone dialog, remove
 * confirmation, Ask AI chat) opens in the host.
 */

/** One take on a line that can be validated (AudioValidationControl). */
export interface ToolAudioTake {
  audioId: string
  label: string | null
  slot: string
  validators: string[]
  validatorCount: number
  isGenerated: boolean
  canValidate: boolean
  blockedReason: string | null
  unrecorded: boolean
}

export interface ToolAudioValidation {
  /** "off": no audio column; "checking": still loading (draw a placeholder). */
  column: "off" | "checking" | "on"
  /** Validations a take needs (the project's audio requirement). */
  requirement: number
  takes: Record<string, ToolAudioTake[]>
}

/** The Audio lens's playable take for a line (CellVoicePanel). */
export interface ToolVoiceTake {
  audioId: string
  durationMs: number
  trimStartMs: number | null
  trimEndMs: number | null
  /** A shared section clip cannot be trimmed per line. */
  trimmable: boolean
  /** Normalised peaks 0..1 for a waveform (≤ 160 buckets; [] when unknown). */
  peaks: number[]
  isGenerated: boolean
  /** The voice that made a generated take, when it differs from the line's. */
  takeVoiceName: string | null
}

export interface ToolVoiceList {
  voices: { id: string; name: string }[]
  /** The line's voice (cast assignment, else the project default). */
  current: Record<string, { id: string; name: string; explicit: boolean }>
  canClone: boolean
}

/** What the source cell menu offers for a row (CellSourceMenu). A string is
 *  the reason the item is disabled; null means available; absent = hidden. */
export interface ToolSourceActions {
  edit?: string | null
  timestamps?: { reason: string | null; startSec: number; endSec: number; canUnlock: boolean }
  hide?: { reason: string | null; hidden: boolean }
  insertAbove?: string | null
  insertBelow?: string | null
  remove?: string | null
}

/** A translation-memory example next to the source (ExamplePanel). */
export interface ToolExample {
  band: "exact" | "high" | "good" | "fair" | "example"
  percent: number
  source: string
  target: string
  fileName: string | null
  isTranslationMemory: boolean
  /** Only an exact match offers Insert. */
  canInsert: boolean
  /** The candidate source against this cell's, for scored bands. */
  diff: { kind: "equal" | "added" | "removed"; text: string }[] | null
}

export interface ToolContextualDraft {
  draftId: string
  text: string
  spanLabel: string
}

/** A smart-edit suggestion over the target text (offsets into the plain value). */
export interface ToolSmartEdit {
  id: string
  start: number
  end: number
  old: string
  new: string
  tier: string
  reason: string | null
  flagOnly: boolean
}

export interface ToolTermSelection {
  /** The selection is a known term (the matcher's verdict). */
  match: boolean
  /** "Add to terminology" is offered. */
  canAdd: boolean
  blockedReason: string | null
}

/** A rect in the frame's viewport (CSS px), to anchor a host popover. */
export interface ToolRect {
  left: number
  top: number
  width: number
  height: number
}
