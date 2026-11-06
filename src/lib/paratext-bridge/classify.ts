// Live sync: classify every unit of a changed file against what Aquilla last
// saw and what it last wrote. This is how "Aquilla never loses a change" is
// kept: a Paratext save from a stale in-memory copy that reverts an Aquilla
// edit is recognised as a clobber, not accepted as the team's latest text.
//
// Pure: takes the previous and new unit sets plus Aquilla's own records.

import type { Unit, UnitSet } from "./units"
import type { PendingEdit } from "./write-back"

/** What Aquilla recorded when it last wrote a unit. */
export interface WrittenRecord {
  unitId: string
  /** rawHash of the unit before Aquilla's write. */
  previousRawHash: string
  /** rawHash of the unit after Aquilla's write. */
  newRawHash: string
}

export type ChangeCase =
  | "theirs-only"    // file changed; Aquilla has no pending or applied edit here → accept
  | "stale-revert"   // file now shows the unit as it was BEFORE Aquilla's write → clobber
  | "both-changed"   // file shows a third value and Aquilla has an edit here → prompt
  | "mine-pending"   // file unchanged here; Aquilla has an unwritten edit → nothing

export interface ClassifiedUnit {
  unitId: string
  case: ChangeCase
  /** Unit as the file holds it now (undefined when it vanished). */
  theirs?: Unit
  /** Unit as Aquilla last saw it. */
  base?: Unit
  /** Aquilla's own text for this unit, when it has one. */
  mine?: string
}

export interface ClassifyInput {
  /** Units Aquilla last derived for this book. */
  lastSeen: UnitSet
  /** Units derived from the file as it is now. */
  current: UnitSet
  /** Aquilla edits not yet written. */
  pending: readonly PendingEdit[]
  /** Aquilla's most recent write per unit (from the write log). */
  written: readonly WrittenRecord[]
}

export interface ClassifyResult {
  /** Units that changed or that Aquilla holds an edit for. Unchanged units
   *  without edits are omitted. */
  units: ClassifiedUnit[]
  clobbers: number
  /** True when `current.blobHash` equals a blob Aquilla itself wrote: an echo
   *  of our own write, nothing to do. Callers pass that hash via `ownBlobHashes`. */
  echo: boolean
  /** IDs that exist now but did not before (structural edit in Paratext). */
  added: string[]
  /** IDs that existed before and are gone now. */
  removed: string[]
}

export function classifyChanges(input: ClassifyInput, ownBlobHashes: ReadonlySet<string> = new Set()): ClassifyResult {
  const { lastSeen, current, pending, written } = input
  if (ownBlobHashes.has(current.blobHash)) {
    return { units: [], clobbers: 0, echo: true, added: [], removed: [] }
  }

  const baseById = new Map(lastSeen.units.map((u) => [u.id, u]))
  const nowById = new Map(current.units.map((u) => [u.id, u]))
  const pendingById = new Map(pending.map((p) => [p.unitId, p]))
  const writtenById = new Map(written.map((w) => [w.unitId, w]))

  const units: ClassifiedUnit[] = []
  let clobbers = 0

  const ids = new Set<string>([...baseById.keys(), ...nowById.keys()])
  for (const id of ids) {
    const base = baseById.get(id)
    const theirs = nowById.get(id)
    const mine = pendingById.get(id)
    const wrote = writtenById.get(id)
    const fileChanged = !base || !theirs || base.rawHash !== theirs.rawHash

    if (!fileChanged) {
      if (mine) units.push({ unitId: id, case: "mine-pending", theirs, base, mine: mine.text })
      continue
    }

    // A reverted write: the unit now carries exactly the bytes it had before
    // Aquilla's write. Paratext saved a copy it loaded before we wrote.
    if (wrote && theirs && theirs.rawHash === wrote.previousRawHash && base?.rawHash === wrote.newRawHash) {
      clobbers++
      units.push({ unitId: id, case: "stale-revert", theirs, base, mine: base.text })
      continue
    }

    if (mine) {
      units.push({ unitId: id, case: "both-changed", theirs, base, mine: mine.text })
      continue
    }

    units.push({ unitId: id, case: "theirs-only", theirs, base })
  }

  return {
    units,
    clobbers,
    echo: false,
    added: [...nowById.keys()].filter((id) => !baseById.has(id)),
    removed: [...baseById.keys()].filter((id) => !nowById.has(id)),
  }
}

/** Keep mine: the resolution becomes a NEW pending edit whose base is theirs,
 *  so the normal write-back checks still apply. */
export function keepMine(c: ClassifiedUnit): PendingEdit | null {
  if (!c.theirs || c.mine === undefined) return null
  return { unitId: c.unitId, text: c.mine, baseRawHash: c.theirs.rawHash }
}
