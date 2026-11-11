// The disk-facing half of editing one Paratext book: read → derive → reconcile
// with what Aquilla last saw (clobber classification), and the guarded write
// with its proof and bookkeeping. No React here, so the per-book textarea page
// (`use-paratext-book.ts`) and the mirrored-project editor (`use-paratext-mirror.ts`)
// share one write path and one proof.

import { deriveUnits, type UnitSet } from "./units"
import { planWriteBack, type PendingEdit, type WriteBackConflict } from "./write-back"
import { classifyChanges, type ClassifiedUnit } from "./classify"
import { bridgeStore } from "./store"
import { paratextTauri } from "./tauri"

export interface BookLocation {
  projectPath: string
  fileName: string
  guid: string
}

export interface BookReconcile {
  units: UnitSet
  /** What Aquilla had reconciled with before this read; null on first open. */
  lastSeen: UnitSet | null
  /** Pending edits the store holds for this book (textarea page only). */
  pending: PendingEdit[]
  /** Units that need the user's decision (stale-revert, both-changed). */
  conflicts: ClassifiedUnit[]
  /** Units Paratext changed on its own since Aquilla last looked. */
  theirs: ClassifiedUnit[]
  onHold: boolean
}

/**
 * Read the book from disk and classify every change against the last-seen
 * unit set. `pending` lets the caller describe edits it holds outside the
 * store (the mirror diffs cells against last-seen); the textarea page passes
 * nothing and the store's pending edits are used.
 *
 * Does NOT advance last-seen: the caller does once it has acted on
 * `theirs` and `conflicts`, so a crash between the two never loses a change.
 */
export async function reconcileBook(loc: BookLocation, opts: { pending?: PendingEdit[] } = {}): Promise<BookReconcile> {
  const bytes = await paratextTauri.readFile(loc.projectPath, loc.fileName)
  const units = await deriveUnits(bytes)
  const book = units.book
  const [storedPending, written, lastSeen, own, hold] = await Promise.all([
    opts.pending ? Promise.resolve(opts.pending) : bridgeStore.pendingEdits(loc.guid, book),
    bridgeStore.writeLog(loc.guid, book),
    bridgeStore.lastSeen(loc.guid, book),
    bridgeStore.ownBlobHashes(loc.guid, book),
    bridgeStore.hold(loc.guid, book),
  ])
  let conflicts: ClassifiedUnit[] = []
  let theirs: ClassifiedUnit[] = []
  let onHold = hold
  if (lastSeen && lastSeen.blobHash !== units.blobHash) {
    const r = classifyChanges({ lastSeen, current: units, pending: storedPending, written }, own)
    if (!r.echo) {
      conflicts = r.units.filter((u) => u.case === "stale-revert" || u.case === "both-changed")
      theirs = r.units.filter((u) => u.case === "theirs-only")
      if (r.clobbers > 0 && !onHold) { onHold = true; await bridgeStore.setHold(loc.guid, book, true) }
    }
  }
  return { units, lastSeen, pending: storedPending, conflicts, theirs, onHold }
}

/**
 * A mirror was just created from these book bytes: make them the base. The
 * cells hold exactly this text, so the first sync must compare the file with
 * it, not with a unit set an earlier session (the per-book page, or a mirror
 * since removed) left under the same project GUID. Against such a stale base
 * every verse Paratext changed in between reads as edited on both sides, and
 * the user is asked to pick between two identical texts.
 *
 * A book whose units cannot be derived keeps whatever base it had.
 */
export async function setMirrorBase(guid: string, books: readonly Uint8Array[]): Promise<void> {
  for (const bytes of books) {
    try {
      const units = await deriveUnits(bytes)
      await bridgeStore.setLastSeen(guid, units.book, units)
    } catch {
      /* first sync falls back to its own first-contact rule */
    }
  }
}

export type WriteBookResult =
  | { kind: "written"; after: UnitSet | null; applied: string[]; conflicts: WriteBackConflict[] }
  | { kind: "refused"; reason: "hold" | "hash" | `proof:${string}` | string }

/**
 * Re-read, plan, prove, write, and record. Refuses while the book is on hold.
 * On success the write log, own-blob set and last-seen all advance to the
 * written state, and the applied pending edits leave the store.
 */
export async function writeBookEdits(
  loc: BookLocation,
  edits: readonly PendingEdit[],
  opts: { allowMarkerChanges?: ReadonlySet<string> } = {},
): Promise<WriteBookResult> {
  // Re-read right before writing; the plan hashes against these bytes and the
  // Rust side refuses if the file moved between read and write.
  const current = await paratextTauri.readFile(loc.projectPath, loc.fileName)
  const before = await deriveUnits(current)
  const book = before.book
  if (await bridgeStore.hold(loc.guid, book)) return { kind: "refused", reason: "hold" }
  if (edits.length === 0) return { kind: "written", after: null, applied: [], conflicts: [] }
  const plan = await planWriteBack(current, edits, { allowMarkerChanges: opts.allowMarkerChanges })
  if (plan.proofFailures.length > 0) return { kind: "refused", reason: `proof:${plan.proofFailures.join("; ")}` }
  if (!plan.bytes || !plan.after) return { kind: "written", after: null, applied: [], conflicts: plan.conflicts }
  try {
    await paratextTauri.writeBook(loc.projectPath, loc.fileName, plan.bytes, before.blobHash)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { kind: "refused", reason: msg.startsWith("EHASH") ? "hash" : msg }
  }
  await bridgeStore.recordOwnBlob(loc.guid, book, plan.after.blobHash)
  await bridgeStore.recordWrites(loc.guid, book, plan.applied)
  await bridgeStore.deletePendingEdits(loc.guid, plan.applied.map((a) => a.unitId))
  await bridgeStore.setLastSeen(loc.guid, book, plan.after)
  return { kind: "written", after: plan.after, applied: plan.applied.map((a) => a.unitId), conflicts: plan.conflicts }
}
