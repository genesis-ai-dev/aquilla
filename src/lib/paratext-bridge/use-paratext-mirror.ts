// A regular Aquilla project that mirrors a Paratext project (see
// `/paratext` → "Open in Aquilla"): the hook behind the editor's Paratext badge.
//
// Outbound: "Write to Paratext" diffs the file's cells against the units
// Aquilla last reconciled with and writes those units through the same proof
// as the per-book page (`book-sync.ts`). Inbound: the folder watcher reports a
// change, the change is classified, Paratext-only edits land as
// `target.cell.commit` events, and anything Aquilla also touched waits for the
// user's mine-or-theirs choice. Last-seen advances only once every unit of a
// change has been acted on.

import { useCallback, useEffect, useRef, useState } from "react"
import { emitTargetCellCommits, type CellCommitInput } from "../sync/events-emit"
import { fetchAllFileCells } from "../sync/cells-read"
import type { CellRow } from "../sync/cells-read-types"
import type { UnitSet } from "./units"
import type { WriteBackConflict } from "./write-back"
import type { ClassifiedUnit } from "./classify"
import { bridgeStore, type MirrorLink } from "./store"
import { reconcileBook, writeBookEdits, type BookLocation } from "./book-sync"
import { diffCellsAgainstUnits, unitsByRef, type MirrorCell } from "./mirror-map"
import { onParatextFileChanged, paratextTauri } from "./tauri"
import { isTauriRuntime } from "../offline/is-tauri"

export interface MirrorHost {
  projectId: string | null
  fileId: string | null
  /** Active target lane tag (what the editor commits to). */
  lane: string
  author: string
  getToken: (fileId: string) => Promise<string | null>
}

export interface MirrorState {
  link: MirrorLink | null
  /** The book this file mirrors; null when the file is not a mirrored book. */
  book: { code: string; fileName: string } | null
  busy: "write" | "sync" | null
  conflicts: ClassifiedUnit[]
  refusals: WriteBackConflict[]
  onHold: boolean
  /** Cells whose reference no unit in the file carries (last write attempt). */
  unmapped: number
  error: string | null
}

export type MirrorWriteResult = { written: number; file: string } | { refused: string }

export interface MirrorActions {
  write: (opts?: { allowMarkerChanges?: Set<string> }) => Promise<MirrorWriteResult>
  resolve: (unitId: string, choice: "mine" | "theirs") => Promise<void>
  resolveAll: (choice: "mine" | "theirs") => Promise<void>
  releaseHold: () => Promise<void>
  dismissRefusals: () => void
}

/** A cell with what a commit back into it needs. */
interface CommitTarget extends MirrorCell {
  parentId: string | null
  sourceEventId: string | null
}

const IDLE: MirrorState = { link: null, book: null, busy: null, conflicts: [], refusals: [], onHold: false, unmapped: 0, error: null }

async function loadCells(host: MirrorHost): Promise<CommitTarget[]> {
  if (!host.projectId || !host.fileId) return []
  const token = await host.getToken(host.fileId)
  if (!token) throw new Error("no sync token")
  const [sources, targets] = await Promise.all([
    fetchAllFileCells(host.projectId, host.fileId, token, "source"),
    fetchAllFileCells(host.projectId, host.fileId, token, "target", host.lane),
  ])
  const targetById = new Map<string, CellRow>(targets.map((r) => [r.cellId, r]))
  const out: CommitTarget[] = []
  for (const s of sources) {
    if (!s.canonicalRef || s.hidden) continue
    const tgt = targetById.get(s.cellId)
    out.push({
      cellId: s.cellId,
      ref: s.canonicalRef,
      ...(tgt ? { value: tgt.value, valueHtml: tgt.valueHtml } : {}),
      parentId: tgt?.eventId ?? s.eventId ?? null,
      sourceEventId: s.eventId ?? null,
    })
  }
  return out
}

export function useParatextMirror(host: MirrorHost): [MirrorState, MirrorActions] {
  const supported = isTauriRuntime()
  const [state, setState] = useState<MirrorState>(IDLE)
  const hostRef = useRef(host)
  hostRef.current = host
  const linkRef = useRef<MirrorLink | null>(null)
  const bookRef = useRef<{ code: string; fileName: string } | null>(null)
  /** Units of the change whose conflicts are still open; becomes last-seen
   *  once the last one is resolved. */
  const pendingUnitsRef = useRef<UnitSet | null>(null)
  const lastBlobRef = useRef<string | null>(null)

  const location = useCallback((): BookLocation | null => {
    const link = linkRef.current
    const book = bookRef.current
    return link && book ? { projectPath: link.projectPath, fileName: book.fileName, guid: link.projectGuid } : null
  }, [])

  // Which Paratext project and book this file mirrors, if any.
  useEffect(() => {
    if (!supported || !host.projectId) { linkRef.current = null; bookRef.current = null; setState(IDLE); return }
    let cancelled = false
    void bridgeStore.linkForProject(host.projectId).then((link) => {
      if (cancelled) return
      const entry = link && host.fileId ? Object.entries(link.books).find(([, b]) => b.fileId === host.fileId) : undefined
      const book = entry ? { code: entry[0], fileName: entry[1].fileName } : null
      linkRef.current = link
      bookRef.current = book
      pendingUnitsRef.current = null
      setState({ ...IDLE, link, book })
    })
    return () => { cancelled = true }
  }, [supported, host.projectId, host.fileId])

  const commitTheirs = useCallback(async (units: ClassifiedUnit[], cells: CommitTarget[]) => {
    const h = hostRef.current
    if (!h.projectId || !h.fileId || units.length === 0) return 0
    const unitRefById = new Map<string, string>()
    for (const u of units) if (u.theirs) unitRefById.set(u.unitId, u.theirs.ref)
    const cellByRef = new Map(cells.map((c) => [c.ref, c]))
    const inputs: CellCommitInput[] = []
    for (const u of units) {
      if (!u.theirs) continue // the unit vanished: nothing to carry into the cell
      const cell = cellByRef.get(u.theirs.ref)
      if (!cell) continue
      const value = u.theirs.text.replace(/[ \t\r\n]+$/, "")
      if ((cell.value ?? "") === value) continue
      inputs.push({
        projectId: h.projectId, fileId: h.fileId, cellId: cell.cellId,
        parentId: cell.parentId, sourceEventId: cell.sourceEventId,
        targetLang: h.lane, value, author: h.author,
      })
    }
    if (inputs.length > 0) await emitTargetCellCommits(inputs)
    return inputs.length
  }, [])

  /** Inbound: read the file, classify against last-seen, land Paratext-only
   *  changes in the cells, hold the rest for the user. */
  const sync = useCallback(async () => {
    const loc = location()
    if (!loc) return
    setState((s) => ({ ...s, busy: "sync", error: null }))
    try {
      const cells = await loadCells(hostRef.current)
      const lastSeen = await bridgeStore.lastSeen(loc.guid, bookRef.current!.code)
      if (!lastSeen) {
        // First contact after the import: the file as it is IS the base.
        const r = await reconcileBook(loc)
        await bridgeStore.setLastSeen(loc.guid, r.units.book, r.units)
        lastBlobRef.current = r.units.blobHash
        setState((s) => ({ ...s, busy: null, onHold: r.onHold }))
        return
      }
      const pending = diffCellsAgainstUnits(cells, lastSeen).edits
      const r = await reconcileBook(loc, { pending })
      lastBlobRef.current = r.units.blobHash
      await commitTheirs(r.theirs, cells)
      if (r.conflicts.length === 0) {
        await bridgeStore.setLastSeen(loc.guid, r.units.book, r.units)
        pendingUnitsRef.current = null
      } else {
        pendingUnitsRef.current = r.units
      }
      setState((s) => ({ ...s, busy: null, conflicts: r.conflicts, onHold: r.onHold }))
    } catch (e) {
      setState((s) => ({ ...s, busy: null, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [location, commitTheirs])

  // First contact + folder watch. Re-runs when the mirrored book changes.
  useEffect(() => {
    const link = state.link
    const book = state.book
    if (!supported || !link || !book) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void sync()
    void paratextTauri.watch(link.projectPath).catch(() => {})
    void onParatextFileChanged((e) => {
      if (e.projectPath !== link.projectPath || e.fileName !== book.fileName) return
      if (e.blobHash === lastBlobRef.current) return
      void sync()
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn })
    return () => { cancelled = true; unlisten?.(); void paratextTauri.unwatch(link.projectPath).catch(() => {}) }
  }, [supported, state.link, state.book, sync])

  const write = useCallback(async (opts?: { allowMarkerChanges?: Set<string> }): Promise<MirrorWriteResult> => {
    const loc = location()
    if (!loc) return { refused: "not-linked" }
    setState((s) => ({ ...s, busy: "write", error: null }))
    try {
      const cells = await loadCells(hostRef.current)
      let base = await bridgeStore.lastSeen(loc.guid, bookRef.current!.code)
      if (!base) {
        const r = await reconcileBook(loc)
        await bridgeStore.setLastSeen(loc.guid, r.units.book, r.units)
        base = r.units
      }
      const { edits, unmapped } = diffCellsAgainstUnits(cells, base)
      const r = await writeBookEdits(loc, edits, { allowMarkerChanges: opts?.allowMarkerChanges })
      if (r.kind === "refused") {
        setState((s) => ({ ...s, busy: null, unmapped: unmapped.length, onHold: r.reason === "hold" ? true : s.onHold }))
        if (r.reason === "hash") void sync()
        return { refused: r.reason }
      }
      if (r.after) lastBlobRef.current = r.after.blobHash
      setState((s) => ({ ...s, busy: null, refusals: r.conflicts, unmapped: unmapped.length }))
      // The file moved under us: classify so the user sees what Paratext did.
      if (r.conflicts.some((c) => c.reason === "base-mismatch")) void sync()
      return { written: r.applied.length, file: loc.fileName }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setState((s) => ({ ...s, busy: null, error: msg }))
      return { refused: msg }
    }
  }, [location, sync])

  const finishResolutions = useCallback(async (remaining: ClassifiedUnit[]) => {
    const loc = location()
    if (remaining.length === 0 && loc && pendingUnitsRef.current) {
      await bridgeStore.setLastSeen(loc.guid, pendingUnitsRef.current.book, pendingUnitsRef.current)
      pendingUnitsRef.current = null
    }
    setState((s) => ({ ...s, conflicts: remaining }))
  }, [location])

  const resolveMany = useCallback(async (picks: { c: ClassifiedUnit; choice: "mine" | "theirs" }[]) => {
    // "Theirs" lands Paratext's text in the cell; "mine" leaves the cell as it
    // is. Either way the file's current unit becomes the base, so the next
    // write re-applies "mine" edits and leaves "theirs" ones alone.
    const theirs = picks.filter((p) => p.choice === "theirs").map((p) => p.c)
    if (theirs.length > 0) {
      const cells = await loadCells(hostRef.current)
      await commitTheirs(theirs, cells)
    }
  }, [commitTheirs])

  const resolve = useCallback(async (unitId: string, choice: "mine" | "theirs") => {
    const c = state.conflicts.find((x) => x.unitId === unitId)
    if (!c) return
    await resolveMany([{ c, choice }])
    await finishResolutions(state.conflicts.filter((x) => x.unitId !== unitId))
  }, [state.conflicts, resolveMany, finishResolutions])

  const resolveAll = useCallback(async (choice: "mine" | "theirs") => {
    await resolveMany(state.conflicts.map((c) => ({ c, choice })))
    await finishResolutions([])
  }, [state.conflicts, resolveMany, finishResolutions])

  const releaseHold = useCallback(async () => {
    const loc = location()
    if (!loc || !bookRef.current) return
    await bridgeStore.setHold(loc.guid, bookRef.current.code, false)
    setState((s) => ({ ...s, onHold: false }))
  }, [location])

  const dismissRefusals = useCallback(() => setState((s) => ({ ...s, refusals: [] })), [])

  return [state, { write, resolve, resolveAll, releaseHold, dismissRefusals }]
}

export { unitsByRef }
