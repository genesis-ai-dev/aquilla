// Reading the copies Aquilla does NOT write to (see copies.ts). A translator
// who edits in Paratext 10 while the mirror writes to the Paratext 9 copy
// still expects to see the edit in Aquilla at once, not after two rounds of
// Send/Receive. So every copy is read; only the live copy is written.
//
// A change in such a copy lands in the cell only when it is Paratext's alone:
// the cell still holds the text that copy had before. A cell that holds a
// third text (an Aquilla edit, or a change from another copy) is left as it
// is and counted as held: Send/Receive merges the two in Paratext, and the
// result arrives through the live copy, where the user has mine-or-theirs.
//
// The copy's base advances only when nothing is held, so a held verse is
// still reported after a restart and clears itself once the texts agree.

import { deriveUnits, type Unit, type UnitSet } from "./units"
import { cellUnitText, unitsByRef, type MirrorCell } from "./mirror-map"
import type { ClassifiedUnit } from "./classify"
import { bridgeStore } from "./store"
import { paratextTauri } from "./tauri"
import type { BookLocation } from "./book-sync"

const trimEnd = (text: string) => text.replace(/[ \t\r\n]+$/, "")

export interface CopyChange {
  /** Units this copy changed while the cell still held the copy's old text. */
  land: Unit[]
  /** Units this copy changed where the cell holds a third text. */
  held: Unit[]
}

/** Pure: what changed in a copy since `base`, judged against the cells. */
export function classifyCopyChange(base: UnitSet, current: UnitSet, cells: readonly MirrorCell[]): CopyChange {
  const baseByRef = unitsByRef(base.units)
  const nowByRef = unitsByRef(current.units)
  const land: Unit[] = []
  const held: Unit[] = []
  for (const cell of cells) {
    const now = nowByRef.get(cell.ref)
    if (!now) continue
    const before = baseByRef.get(cell.ref)
    if (before && before.rawHash === now.rawHash) continue
    const mine = cell.value === undefined && !cell.valueHtml ? "" : cellUnitText(cell)
    if (mine === trimEnd(now.text)) continue
    if (mine === (before ? trimEnd(before.text) : "")) land.push(now)
    else held.push(now)
  }
  return { land, held }
}

/**
 * A verse both sides changed is no conflict when they changed it to the same
 * text. That is the normal case once a change read from another copy reaches
 * the live copy through Send/Receive.
 */
export function isSettled(c: ClassifiedUnit): boolean {
  return c.case === "both-changed" && !!c.theirs && c.mine !== undefined && c.mine === trimEnd(c.theirs.text)
}

export interface CopyRead extends CopyChange {
  units: UnitSet
}

/**
 * Read the book in a copy Aquilla does not write to and classify it. The first
 * read of a copy makes the file as it is the base: the copies differ between
 * Send/Receives, and those differences are not edits to bring in.
 *
 * Does NOT advance the base otherwise; the caller does with `settleCopy` once
 * it has landed `land`.
 */
export async function readCopy(loc: BookLocation, cells: readonly MirrorCell[]): Promise<CopyRead> {
  const units = await deriveUnits(await paratextTauri.readFile(loc.projectPath, loc.fileName))
  const base = await bridgeStore.lastSeen(loc.stateId, units.book)
  if (!base) {
    await bridgeStore.setLastSeen(loc.stateId, units.book, units)
    return { units, land: [], held: [] }
  }
  if (base.blobHash === units.blobHash) return { units, land: [], held: [] }
  return { units, ...classifyCopyChange(base, units, cells) }
}

/** Advance the copy's base, unless a held verse still needs it. */
export async function settleCopy(loc: BookLocation, read: CopyRead): Promise<void> {
  if (read.held.length > 0) return
  await bridgeStore.setLastSeen(loc.stateId, read.units.book, read.units)
}
