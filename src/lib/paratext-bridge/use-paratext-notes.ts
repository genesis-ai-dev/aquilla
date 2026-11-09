// The registered user's Paratext notes for one project: read on open, kept
// fresh by the folder watcher (started by useParatextBook for the same
// project), appended with a byte-level proof. Notes are append-only here;
// editing or resolving them stays in Paratext.

import { useCallback, useEffect, useRef, useState } from "react"
import { sha256Hex } from "./hash"
import { notesFileName, parseNotes, planNoteAppend, unitVerseRef, type ParatextNote } from "./notes"
import type { Unit } from "./units"
import { onParatextFileChanged, paratextTauri } from "./tauri"
import type { BridgeProject } from "./use-paratext-discovery"

export interface NotesState {
  notes: ParatextNote[]
  loading: boolean
  error: string | null
  /** The user has no notes file in this project yet; the first note creates it. */
  fileMissing: boolean
}

export interface NotesActions {
  addNote: (book: string, unit: Unit, text: string) => Promise<{ file: string } | { refused: string }>
}

const isMissing = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e)
  return /No such file|os error 2\b|ENOENT|cannot find the file/i.test(msg)
}

export function useParatextNotes(project: BridgeProject | null, registeredUser: string | null): [NotesState, NotesActions] {
  const [state, setState] = useState<NotesState>({ notes: [], loading: true, error: null, fileMissing: false })
  const fileName = registeredUser ? notesFileName(registeredUser) : null
  const bytesRef = useRef<Uint8Array | null>(null)

  const load = useCallback(async () => {
    if (!project || !fileName) { setState({ notes: [], loading: false, error: null, fileMissing: false }); return }
    try {
      const bytes = await paratextTauri.readFile(project.path, fileName)
      bytesRef.current = bytes
      setState({ notes: parseNotes(bytes).notes, loading: false, error: null, fileMissing: false })
    } catch (e) {
      if (isMissing(e)) { bytesRef.current = null; setState({ notes: [], loading: false, error: null, fileMissing: true }); return }
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [project, fileName])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!project || !fileName) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void onParatextFileChanged((e) => {
      if (e.projectPath === project.path && e.fileName === fileName) void load()
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn })
    return () => { cancelled = true; unlisten?.() }
  }, [project, fileName, load])

  const addNote = useCallback(async (book: string, unit: Unit, text: string) => {
    if (!project || !fileName || !registeredUser) return { refused: "no-registration" }
    if (!text.trim()) return { refused: "empty" }
    try {
      // Re-read right before writing so the splice lands on what is on disk now.
      let current: Uint8Array | null = null
      try { current = await paratextTauri.readFile(project.path, fileName) } catch (e) { if (!isMissing(e)) throw e }
      const plan = planNoteAppend(current, { user: registeredUser, verseRef: unitVerseRef(book, unit), verse: unit.kind === "verse" ? unit.verse : "0", verseText: unit.text, text })
      if (!plan.ok || !plan.bytes) return { refused: `proof:${plan.proofFailures.join("; ")}` }
      await paratextTauri.writeNotes(project.path, fileName, plan.bytes, current ? await sha256Hex(current) : null)
      bytesRef.current = plan.bytes
      setState({ notes: parseNotes(plan.bytes).notes, loading: false, error: null, fileMissing: false })
      return { file: fileName }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith("EHASH") || msg.startsWith("EEXIST")) void load()
      return { refused: msg }
    }
  }, [project, fileName, registeredUser, load])

  return [state, { addNote }]
}
