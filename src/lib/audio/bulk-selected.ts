// Bulk actions over the current cell selection: translate-only,
// translate-then-synth, or synth-only. Runs cells sequentially so the
// existing per-cell status badges (synth + transcribe) light up one at a
// time and a flaky API can be cancelled mid-stream.

import * as Y from "yjs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { synthAndAttachAudio, synthAndAttachAudioGroup } from "./synth-and-attach"
import { setCellTtsSettings } from "./cell-tts-settings"
import { setTtsStatus, ttsStatusKey } from "./tts"
import { AiModelConsentDeniedError } from "./ai-consent"
import { getPlainText } from "@/lib/richtext/translated-xml"

interface RunArgs {
  cells: CellData[]
  doc: Y.Doc
  project: ProjectRecord
  session: FrontierSession | null
  username: string
  /** Translation entry point. Required for translate-* paths. */
  completeSingle?: (cell: CellData) => Promise<void> | void
  /** Voice id to use when synthesizing. Required for synth-* paths. */
  voiceId?: string
}

function readTranslated(doc: Y.Doc, cellId: string): string {
  const cells = doc.getMap("cells")
  const yCell = cells.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) return ""
  const frag = yCell.get("translatedXml") as Y.XmlFragment | undefined
  if (frag) return getPlainText(frag).trim()
  return ((yCell.get("translated") as string) ?? "").trim()
}

/** Translate any selected cells that are missing a translation. */
export async function translateMissing(args: RunArgs): Promise<void> {
  const { cells, completeSingle } = args
  if (!completeSingle) throw new Error("Translation isn't configured for this project.")
  for (const cell of cells) {
    if (cell.translated.trim()) continue
    if (!cell.original?.trim()) continue
    try {
      await completeSingle(cell)
    } catch (e) {
      console.warn("[bulk-selected] translation failed for", cell.id, e)
      // Keep going — other cells in the selection may still translate.
    }
  }
}

/**
 * Synthesize each cell sequentially. Pre-condition: every cell already has
 * translated text. Use translateThenSynth to fill in missing translations
 * first.
 */
export async function synthEach(args: RunArgs): Promise<void> {
  const { cells, doc, project, session, username, voiceId } = args
  if (!session?.jwt) throw new Error("Sign in to upload audio")
  if (project.origin?.kind === "git") throw new Error("AI voice not supported on git projects yet")

  for (const cell of cells) {
    const text = readTranslated(doc, cell.id) || cell.translated.trim()
    if (!text) continue
    if (voiceId) setCellTtsSettings(doc, cell.id, { voiceId })

    const statusKey = ttsStatusKey(cell.id)
    setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
    try {
      await synthAndAttachAudio({
        doc,
        cellId: cell.id,
        cellText: text,
        cellOriginal: cell.original,
        cellContext: cell.context,
        cellLabel: cell.cellLabel,
        projectId: project.id,
        sourceLanguage: project.sourceLanguage,
        languageTag: project.targetLanguage,
        session,
        username,
        projectTtsSettings: project.ttsSettings,
        cellVoiceId: voiceId,
        onTtsProgress: (p) => {
          setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
          if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
            setTtsStatus(statusKey, { kind: "synthesizing" })
          }
        },
      })
      setTtsStatus(statusKey, { kind: "idle" })
    } catch (e) {
      if (e instanceof AiModelConsentDeniedError) {
        setTtsStatus(statusKey, { kind: "idle" })
        return // user declined model download — stop the bulk run entirely
      }
      setTtsStatus(statusKey, { kind: "error", message: e instanceof Error ? e.message : String(e) })
      // Continue to next cell rather than abort the whole batch.
    }
  }
}

/**
 * For each cell: translate if needed, then synthesize. Order is preserved.
 * If translation fails for a cell we skip its synth and move on.
 */
export async function translateThenSynth(args: RunArgs): Promise<void> {
  const { cells, doc, completeSingle } = args
  if (!completeSingle) {
    // No translation provider — fall back to synth-only for any cells that
    // already have translated text.
    return synthEach(args)
  }
  for (const cell of cells) {
    if (!cell.translated.trim()) {
      if (!cell.original?.trim()) continue
      try {
        await completeSingle(cell)
      } catch (e) {
        console.warn("[bulk-selected] translation failed for", cell.id, e)
        continue
      }
    }
    // Run synth using the freshly-translated text. Re-read from doc so we
    // pick up the result of the streaming completion above.
    const fresh: CellData = { ...cell, translated: readTranslated(doc, cell.id) || cell.translated }
    await synthEach({ ...args, cells: [fresh] })
  }
}

/**
 * Group synthesis: send every selected cell's text to Gemini in a single
 * call so prosody flows naturally between them, then use Whisper alignment
 * to slice the result back per cell. Status is fanned to every cell so
 * each row pulses while the take is in flight.
 *
 * Returns the combined blob so callers can preview-play it.
 */
export async function synthAsOneTake(args: RunArgs): Promise<{ blob: Blob } | null> {
  const { cells, doc, project, session, username, voiceId } = args
  if (!session?.jwt) throw new Error("Sign in to upload audio")
  if (project.origin?.kind === "git") throw new Error("AI voice not supported on git projects yet")

  const eligible = cells.filter((c) => {
    const t = readTranslated(doc, c.id) || c.translated.trim()
    return t.length > 0
  })
  if (eligible.length === 0) return null

  const statusKeys = eligible.map((c) => ttsStatusKey(c.id))
  const setAll = (status: Parameters<typeof setTtsStatus>[1]) => {
    for (const k of statusKeys) setTtsStatus(k, status)
  }

  // Persist the chosen voice on every cell so re-runs stay consistent.
  if (voiceId) for (const c of eligible) setCellTtsSettings(doc, c.id, { voiceId })

  setAll({ kind: "loading", loaded: 0, total: 0, file: "" })
  try {
    const result = await synthAndAttachAudioGroup({
      doc,
      cells: eligible.map((c) => ({
        id: c.id,
        text: readTranslated(doc, c.id) || c.translated,
        original: c.original,
        context: c.context,
        cellLabel: c.cellLabel,
      })),
      projectId: project.id,
      sourceLanguage: project.sourceLanguage,
      languageTag: project.targetLanguage,
      session,
      username,
      projectTtsSettings: project.ttsSettings,
      voiceId,
      onTtsProgress: (p) => {
        setAll({ kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
        if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
          setAll({ kind: "synthesizing" })
        }
      },
      onTranscribeProgress: (p) => {
        setAll({ kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
        if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
          setAll({ kind: "synthesizing" })
        }
      },
    })
    setAll({ kind: "idle" })
    return { blob: result.blob }
  } catch (e) {
    if (e instanceof AiModelConsentDeniedError) {
      setAll({ kind: "idle" })
      return null
    }
    setAll({
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

/**
 * Translate any cells missing a translation, then run a single one-take
 * group synth across the whole selection.
 */
export async function translateThenSynthAsOneTake(args: RunArgs): Promise<{ blob: Blob } | null> {
  const { cells, doc, completeSingle } = args
  if (completeSingle) {
    for (const cell of cells) {
      if (cell.translated.trim()) continue
      if (!cell.original?.trim()) continue
      try {
        await completeSingle(cell)
      } catch (e) {
        console.warn("[bulk-selected] translation failed for", cell.id, e)
      }
    }
  }
  // Re-read each cell's translated text from the doc so the take uses the
  // freshly-completed values. The CellData passed in still reflects the
  // pre-translation snapshot.
  const fresh: CellData[] = cells.map((c) => ({
    ...c,
    translated: readTranslated(doc, c.id) || c.translated,
  }))
  return synthAsOneTake({ ...args, cells: fresh })
}
