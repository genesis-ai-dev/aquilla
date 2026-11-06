// State machine for one open Paratext book: read → derive → edit → write back,
// with the folder watcher feeding live changes through the clobber classifier.
//
// Everything that touches disk goes through paratextTauri; everything that
// decides goes through the pure modules (units, write-back, classify, access).

import { useCallback, useEffect, useRef, useState } from "react"
import { deriveUnits, type Unit, type UnitSet } from "./units"
import { planWriteBack, type PendingEdit, type WriteBackConflict } from "./write-back"
import { classifyChanges, keepMine, type ClassifiedUnit } from "./classify"
import { editDenial, type EditDenial } from "./access"
import { bridgeStore } from "./store"
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
  const guid = project?.guid ?? null
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
    if (!project || !fileName || !guid) return
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const bytes = await paratextTauri.readFile(project.path, fileName)
      const units = await deriveUnits(bytes)
      const book = units.book
      bookRef.current = book
      const [pending, written, lastSeen, own, hold] = await Promise.all([
        bridgeStore.pendingEdits(guid, book),
        bridgeStore.writeLog(guid, book),
        bridgeStore.lastSeen(guid, book),
        bridgeStore.ownBlobHashes(guid, book),
        bridgeStore.hold(guid, book),
      ])
      let conflicts: ClassifiedUnit[] = []
      let theirs = 0
      let onHold = hold
      if (lastSeen && lastSeen.blobHash !== units.blobHash) {
        const r = classifyChanges({ lastSeen, current: units, pending, written }, own)
        if (!r.echo) {
          conflicts = r.units.filter((u) => u.case === "stale-revert" || u.case === "both-changed")
          theirs = r.units.filter((u) => u.case === "theirs-only").length
          if (r.clobbers > 0 && !onHold) { onHold = true; await bridgeStore.setHold(guid, book, true) }
        }
      }
      await bridgeStore.setLastSeen(guid, book, units)
      const edits = new Map(pending.map((p) => [p.unitId, p]))
      unitsRef.current = units
      editsRef.current = edits
      setState({
        loading: false, error: null, units, edits, conflicts, refusals: [], onHold, writing: false, theirsCount: theirs,
        denial: computeDenial(book, 0) === "chapter-not-granted" ? null : computeDenial(book, 0),
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [project, fileName, guid, computeDenial])

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
    if (!guid || !bookRef.current) return
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
    if (reverted) await bridgeStore.deletePendingEdits(guid, [unit.id])
    else await bridgeStore.putPendingEdit(guid, book, edit)
  }, [guid])

  const discardEdits = useCallback(async () => {
    if (!guid || !bookRef.current) return
    await bridgeStore.clearPendingEdits(guid, bookRef.current)
    editsRef.current = new Map()
    setState((s) => ({ ...s, edits: new Map(), refusals: [] }))
  }, [guid])

  const write = useCallback(async (opts?: { allowMarkerChanges?: Set<string> }) => {
    const units = unitsRef.current
    if (!project || !fileName || !guid || !units) return { refused: "not-loaded" }
    const book = units.book
    if (await bridgeStore.hold(guid, book)) return { refused: "hold" }
    const edits = [...editsRef.current.values()]
    if (edits.length === 0) return { written: 0, file: fileName }
    setState((s) => ({ ...s, writing: true }))
    try {
      // Re-read right before writing; the plan hashes against these bytes and
      // the Rust side refuses if the file moved between read and write.
      const current = await paratextTauri.readFile(project.path, fileName)
      const plan = await planWriteBack(current, edits, { allowMarkerChanges: opts?.allowMarkerChanges })
      if (plan.proofFailures.length > 0) {
        return { refused: `proof:${plan.proofFailures.join("; ")}` }
      }
      if (plan.bytes && plan.after) {
        const before = await deriveUnits(current)
        await paratextTauri.writeBook(project.path, fileName, plan.bytes, before.blobHash)
        await bridgeStore.recordOwnBlob(guid, book, plan.after.blobHash)
        await bridgeStore.recordWrites(guid, book, plan.applied)
        await bridgeStore.deletePendingEdits(guid, plan.applied.map((a) => a.unitId))
        await bridgeStore.setLastSeen(guid, book, plan.after)
        unitsRef.current = plan.after
        const remaining = new Map(editsRef.current)
        for (const a of plan.applied) remaining.delete(a.unitId)
        editsRef.current = remaining
        setState((s) => ({ ...s, units: plan.after!, edits: remaining, refusals: plan.conflicts, writing: false }))
      } else {
        setState((s) => ({ ...s, refusals: plan.conflicts, writing: false }))
      }
      // base-mismatch conflicts mean the file moved under us: reload to classify.
      if (plan.conflicts.some((c) => c.reason === "base-mismatch")) void load()
      return { written: plan.applied.length, file: fileName }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setState((s) => ({ ...s, writing: false }))
      if (msg.startsWith("EHASH")) { void load(); return { refused: "hash" } }
      return { refused: msg }
    }
  }, [project, fileName, guid, load])

  const resolveOne = useCallback(async (c: ClassifiedUnit, choice: "mine" | "theirs") => {
    if (!guid || !bookRef.current) return
    const next = new Map(editsRef.current)
    if (choice === "mine") {
      const edit = keepMine(c)
      if (edit) { next.set(c.unitId, edit); await bridgeStore.putPendingEdit(guid, bookRef.current, edit) }
    } else {
      next.delete(c.unitId)
      await bridgeStore.deletePendingEdits(guid, [c.unitId])
    }
    editsRef.current = next
  }, [guid])

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
    if (!guid || !bookRef.current) return
    await bridgeStore.setHold(guid, bookRef.current, false)
    setState((s) => ({ ...s, onHold: false }))
  }, [guid])

  const dismissRefusals = useCallback(() => setState((s) => ({ ...s, refusals: [] })), [])

  return [state, { setEditText, discardEdits, write, resolve, resolveAll, releaseHold, dismissRefusals }]
}
