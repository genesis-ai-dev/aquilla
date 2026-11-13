// State machine for one open Paratext book: read → derive → edit → write back,
// with the folder watcher feeding live changes through the clobber classifier.
//
// Everything that touches disk goes through paratextTauri; everything that
// decides goes through the pure modules (units, write-back, classify, access).

import { useCallback, useEffect, useRef, useState } from "react"
import type { Unit, UnitSet } from "./units"
import type { PendingEdit, WriteBackConflict } from "./write-back"
import { keepMine, type ClassifiedUnit } from "./classify"
import { editDenial, type EditDenial } from "./access"
import { bridgeStore } from "./store"
import { reconcileBook, writeBookEdits } from "./book-sync"
import { onParatextFileChanged, paratextTauri } from "./tauri"
import type { BridgeProject } from "./use-paratext-discovery"

export type Denial = EditDenial | "no-registration" | null

export interface BookState {
  loading: boolean
  error: string | null
  units: UnitSet | null
  /** Pending edits keyed by unit ID. */
  edits: Map<string, PendingEdit>
  /** Units that changed on disk and need the user's decision. */
  conflicts: ClassifiedUnit[]
  /** Write-back refusals from the last attempt (marker integrity, missing). */
  refusals: WriteBackConflict[]
  onHold: boolean
  writing: boolean
  /** Units Paratext changed on its own since opening (accepted silently). */
  theirsCount: number
  denial: Denial
}

export interface BookActions {
  setEditText: (unit: Unit, text: string) => Promise<void>
  discardEdits: () => Promise<void>
  write: (opts?: { allowMarkerChanges?: Set<string> }) => Promise<{ written: number; file: string } | { refused: string }>
  resolve: (unitId: string, choice: "mine" | "theirs") => Promise<void>
  resolveAll: (choice: "mine" | "theirs") => Promise<void>
  releaseHold: () => Promise<void>
  dismissRefusals: () => void
}

export function useParatextBook(project: BridgeProject | null, fileName: string | null, registeredUser: string | null): [BookState, BookActions] {
  const [state, setState] = useState<BookState>({
    loading: true, error: null, units: null, edits: new Map(), conflicts: [], refusals: [], onHold: false, writing: false, theirsCount: 0, denial: null,
  })
  const stateId = project?.stateId ?? null
  const bookRef = useRef<string | null>(null)
  const unitsRef = useRef<UnitSet | null>(null)
  const editsRef = useRef<Map<string, PendingEdit>>(new Map())

  const computeDenial = useCallback((book: string, chapter: number): Denial => {
    if (!project) return null
    if (!registeredUser) return "no-registration"
    if (!project.access) return null
    return editDenial(project.access, registeredUser, book, chapter)
  }, [project, registeredUser])

  // Load + derive, and reconcile with what Aquilla last saw.
  const load = useCallback(async () => {
    if (!project || !fileName || !stateId) return
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      await bridgeStore.adoptLegacyState(project.guid, stateId)
      const r = await reconcileBook({ projectPath: project.path, fileName, stateId })
      const book = r.units.book
      bookRef.current = book
      // The textarea page has no cells of its own: Paratext's changes become
      // the new base the moment they are seen.
      await bridgeStore.setLastSeen(stateId, book, r.units)
      const edits = new Map(r.pending.map((p) => [p.unitId, p]))
      unitsRef.current = r.units
      editsRef.current = edits
      setState({
        loading: false, error: null, units: r.units, edits, conflicts: r.conflicts, refusals: [], onHold: r.onHold, writing: false, theirsCount: r.theirs.length,
        denial: computeDenial(book, 0) === "chapter-not-granted" ? null : computeDenial(book, 0),
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [project, fileName, stateId, computeDenial])

  useEffect(() => { void load() }, [load])

  // Watch the folder; a change to our file re-runs load (which classifies).
  useEffect(() => {
    if (!project || !fileName) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void paratextTauri.watch(project.path).catch(() => {})
    void onParatextFileChanged((e) => {
      if (e.projectPath !== project.path || e.fileName !== fileName) return
      if (unitsRef.current && e.blobHash === unitsRef.current.blobHash) return
      void load()
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn })
    return () => { cancelled = true; unlisten?.(); void paratextTauri.unwatch(project.path).catch(() => {}) }
  }, [project, fileName, load])

  const setEditText = useCallback(async (unit: Unit, text: string) => {
    if (!stateId || !bookRef.current) return
    const book = bookRef.current
    const next = new Map(editsRef.current)
    // Keep the text exactly as typed: trimming here would eat a trailing space
    // on every keystroke. planWriteBack trims trailing whitespace at write time.
    const trimmed = text.replace(/[ \t\r\n]+$/, "")
    const reverted = trimmed === unit.text.replace(/[ \t\r\n]+$/, "")
    const edit = { unitId: unit.id, text, baseRawHash: unit.rawHash }
    if (reverted) next.delete(unit.id)
    else next.set(unit.id, edit)
    // Update React state before touching IndexedDB: the textarea is controlled,
    // and a render with the old value between the keystroke and the awaited
    // write resets the caret to the end of the field.
    editsRef.current = next
    setState((s) => ({ ...s, edits: next }))
    if (reverted) await bridgeStore.deletePendingEdits(stateId, [unit.id])
    else await bridgeStore.putPendingEdit(stateId, book, edit)
  }, [stateId])

  const discardEdits = useCallback(async () => {
    if (!stateId || !bookRef.current) return
    await bridgeStore.clearPendingEdits(stateId, bookRef.current)
    editsRef.current = new Map()
    setState((s) => ({ ...s, edits: new Map(), refusals: [] }))
  }, [stateId])

  const write = useCallback(async (opts?: { allowMarkerChanges?: Set<string> }) => {
    const units = unitsRef.current
    if (!project || !fileName || !stateId || !units) return { refused: "not-loaded" }
    const edits = [...editsRef.current.values()]
    if (edits.length === 0) return { written: 0, file: fileName }
    setState((s) => ({ ...s, writing: true }))
    const r = await writeBookEdits({ projectPath: project.path, fileName, stateId }, edits, { allowMarkerChanges: opts?.allowMarkerChanges })
    if (r.kind === "refused") {
      setState((s) => ({ ...s, writing: false }))
      if (r.reason === "hash") void load()
      return { refused: r.reason }
    }
    const remaining = new Map(editsRef.current)
    for (const id of r.applied) remaining.delete(id)
    editsRef.current = remaining
    if (r.after) unitsRef.current = r.after
    setState((s) => ({ ...s, units: r.after ?? s.units, edits: remaining, refusals: r.conflicts, writing: false }))
    // base-mismatch conflicts mean the file moved under us: reload to classify.
    if (r.conflicts.some((c) => c.reason === "base-mismatch")) void load()
    return { written: r.applied.length, file: fileName }
  }, [project, fileName, stateId, load])

  const resolveOne = useCallback(async (c: ClassifiedUnit, choice: "mine" | "theirs") => {
    if (!stateId || !bookRef.current) return
    const next = new Map(editsRef.current)
    if (choice === "mine") {
      const edit = keepMine(c)
      if (edit) { next.set(c.unitId, edit); await bridgeStore.putPendingEdit(stateId, bookRef.current, edit) }
    } else {
      next.delete(c.unitId)
      await bridgeStore.deletePendingEdits(stateId, [c.unitId])
    }
    editsRef.current = next
  }, [stateId])

  const resolve = useCallback(async (unitId: string, choice: "mine" | "theirs") => {
    const c = state.conflicts.find((x) => x.unitId === unitId)
    if (!c) return
    await resolveOne(c, choice)
    setState((s) => ({ ...s, edits: new Map(editsRef.current), conflicts: s.conflicts.filter((x) => x.unitId !== unitId) }))
  }, [state.conflicts, resolveOne])

  const resolveAll = useCallback(async (choice: "mine" | "theirs") => {
    for (const c of state.conflicts) await resolveOne(c, choice)
    setState((s) => ({ ...s, edits: new Map(editsRef.current), conflicts: [] }))
  }, [state.conflicts, resolveOne])

  const releaseHold = useCallback(async () => {
    if (!stateId || !bookRef.current) return
    await bridgeStore.setHold(stateId, bookRef.current, false)
    setState((s) => ({ ...s, onHold: false }))
  }, [stateId])

  const dismissRefusals = useCallback(() => setState((s) => ({ ...s, refusals: [] })), [])

  return [state, { setEditText, discardEdits, write, resolve, resolveAll, releaseHold, dismissRefusals }]
}
