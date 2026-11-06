// Write-back: splice edited units into a book's bytes and PROVE that only the
// intended units changed. If any check fails, nothing is written.
//
// This module never touches disk. It takes the current bytes (re-read by the
// caller just before writing), the pending edits, and returns either the new
// bytes with the proof, or the reasons it refused. The caller (Tauri side)
// does the backup + write.

import { deriveUnits, type Unit, type UnitSet } from "./units"

export interface PendingEdit {
  unitId: string
  /** The text the user wants in the unit (no trailing line break). */
  text: string
  /** `rawHash` of the unit when the user based this edit on it. */
  baseRawHash: string
}

export type WriteBackConflictReason =
  | "unit-missing"        // the unit ID no longer exists in the file
  | "base-mismatch"       // the file's unit changed since the edit was based
  | "marker-integrity"    // the edit drops or adds protected markers

export interface WriteBackConflict {
  unitId: string
  reason: WriteBackConflictReason
  /** What the file holds now for this unit, when it still exists. */
  current?: Unit
  edit: PendingEdit
}

export interface WriteBackPlan {
  ok: boolean
  /** The bytes to write. Present only when `ok` and at least one edit applied. */
  bytes?: Uint8Array
  /** Units re-derived from `bytes`. */
  after?: UnitSet
  /** Edits whose bytes landed, with each unit's previous and new rawHash —
   *  the record clobber detection needs. */
  applied: { unitId: string; previousRawHash: string; newRawHash: string }[]
  conflicts: WriteBackConflict[]
  /** Proof failures: the splice produced changes outside the intended edits.
   *  Any entry here means `ok` is false and nothing must be written. */
  proofFailures: string[]
}

/** Markers that must survive an edit unless the user changed them on purpose:
 *  notes, cross references and their children. Character styles (\nd, \add,
 *  \w …) are the translator's to add or drop. */
const PROTECTED_MARKERS = new Set(["f", "fe", "x", "fr", "ft", "fq", "fqa", "fk", "fl", "fw", "fp", "fv", "fdc", "fm", "xo", "xt", "xk", "xq", "xta", "xop", "xot", "xnt", "xdc", "fig"])

const MARKER_RE = /\\\+?([a-zA-Z]+(?:-[a-zA-Z]+)*\d*)\*?/g

/** Multiset of protected markers (with their `*` closers) in a text. */
export function protectedMarkerCounts(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of text.matchAll(MARKER_RE)) {
    const base = m[1].replace(/\d+$/, "")
    if (!PROTECTED_MARKERS.has(base)) continue
    const key = m[0].replace(/^\\\+/, "\\")
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

export interface WriteBackOptions {
  /** Let an edit change protected markers (the user confirmed the change). */
  allowMarkerChanges?: ReadonlySet<string>
}

const encoder = new TextEncoder()

/**
 * Plan a write-back against the CURRENT bytes of the file.
 *
 * Steps 3–8 of the write-back procedure in the plan: re-derive, hash-check each
 * edit, marker integrity, splice end→start, re-derive, prove the diff.
 */
export async function planWriteBack(
  currentBytes: Uint8Array,
  edits: readonly PendingEdit[],
  opts: WriteBackOptions = {},
): Promise<WriteBackPlan> {
  const before = await deriveUnits(currentBytes)
  const byId = new Map(before.units.map((u) => [u.id, u]))

  const conflicts: WriteBackConflict[] = []
  const toApply: { unit: Unit; edit: PendingEdit }[] = []

  for (const rawEdit of edits) {
    // Spans never include trailing whitespace (the line break after a unit is
    // outside it), so an edit cannot carry any either; normalise up front so
    // the proof compares like with like.
    const edit: PendingEdit = { ...rawEdit, text: rawEdit.text.replace(/[ \t\r\n]+$/, "") }
    const unit = byId.get(edit.unitId)
    if (!unit) { conflicts.push({ unitId: edit.unitId, reason: "unit-missing", edit }); continue }
    if (unit.rawHash !== edit.baseRawHash) { conflicts.push({ unitId: edit.unitId, reason: "base-mismatch", current: unit, edit }); continue }
    if (!opts.allowMarkerChanges?.has(edit.unitId) &&
        !sameCounts(protectedMarkerCounts(unit.text), protectedMarkerCounts(edit.text))) {
      conflicts.push({ unitId: edit.unitId, reason: "marker-integrity", current: unit, edit })
      continue
    }
    if (unit.text === edit.text) continue // nothing to do; not a conflict
    toApply.push({ unit, edit })
  }

  if (toApply.length === 0) {
    return { ok: conflicts.length === 0, applied: [], conflicts, proofFailures: [] }
  }

  // Splice from the end of the file to the start so earlier offsets stay valid.
  toApply.sort((a, b) => b.unit.span.start - a.unit.span.start)
  const pieces: Uint8Array[] = []
  let cursorEnd = currentBytes.length
  for (const { unit, edit } of toApply) {
    pieces.push(currentBytes.subarray(unit.span.end, cursorEnd))
    let replacement = edit.text.replace(/\r\n?|\n/g, before.lineEnding)
    let spliceStart = unit.span.start
    const prev = currentBytes[unit.span.start - 1]
    const prevIsSpace = prev === 0x20 || prev === 0x09
    if (unit.span.start === unit.span.end && replacement.length > 0 && !prevIsSpace) {
      // An empty verse like `\v 2\r\n` has an empty span right after the
      // number; writing text there needs the separating space the line lacks.
      replacement = " " + replacement
    } else if (unit.span.start < unit.span.end && replacement.length === 0 && prevIsSpace) {
      // Emptying a unit drops the separating space too, the mirror image of
      // the rule above, so fill-then-empty restores the original bytes.
      spliceStart = unit.span.start - 1
    }
    pieces.push(encoder.encode(replacement))
    cursorEnd = spliceStart
  }
  pieces.push(currentBytes.subarray(0, cursorEnd))
  pieces.reverse()
  const total = pieces.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of pieces) { out.set(p, o); o += p.length }

  // Proof: re-derive and compare.
  const after = await deriveUnits(out)
  const proofFailures: string[] = []
  const intended = new Set(toApply.map((t) => t.unit.id))
  const afterById = new Map(after.units.map((u) => [u.id, u]))

  if (before.units.length !== after.units.length) {
    proofFailures.push(`unit count changed ${before.units.length} → ${after.units.length}`)
  }
  for (const u of before.units) {
    const a = afterById.get(u.id)
    if (!a) { proofFailures.push(`unit ${u.id} disappeared`); continue }
    if (a.rawHash !== u.rawHash && !intended.has(u.id)) proofFailures.push(`unit ${u.id} changed without an edit`)
  }
  for (const u of after.units) if (!byId.has(u.id)) proofFailures.push(`unit ${u.id} appeared`)
  for (const { unit, edit } of toApply) {
    const a = afterById.get(unit.id)
    if (a && a.text !== edit.text.replace(/[ \t\r\n]+$/, "").replace(/\r\n?|\n/g, before.lineEnding)) {
      proofFailures.push(`unit ${unit.id} does not read back as written`)
    }
  }
  if (after.hasBom !== before.hasBom) proofFailures.push("BOM state changed")

  if (proofFailures.length > 0) {
    return { ok: false, applied: [], conflicts, proofFailures }
  }

  return {
    ok: conflicts.length === 0,
    bytes: out,
    after,
    applied: toApply.map(({ unit }) => ({
      unitId: unit.id,
      previousRawHash: unit.rawHash,
      newRawHash: afterById.get(unit.id)!.rawHash,
    })),
    conflicts,
    proofFailures,
  }
}
