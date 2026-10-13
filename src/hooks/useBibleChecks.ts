// Bible data checks for the open file (AQU-1688).
//
// Loads the book's voices and structure layers through the pack client (once
// per session; IndexedDB keeps them offline), compiles every cell's
// expectation once per file, and hands the rule engine a per-cell lookup. The
// compile is keyed by pack version, the cells' refs and the Language profile,
// never by cell text, so typing in one cell re-checks only that cell.
//
// Nothing is fetched while the checks are off or dormant, and they are off
// unless the open file is a Bible book (AQU-1685): a Bible data check over a
// scripture file is the checks' form of "a Bible is open". AQU-1697: the text
// layer (several MB) loads only while a check that reads it can run (numbers,
// negation, run-on sentences), and `fileScan` loads the structure layer for
// Check file's scans (headings, verse numbering) when it runs.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { CellCheckContext } from "@/lib/rules/rule-engine"
import { loadLayer, loadManifest } from "@/lib/bible-data/pack-client"
import { mapLayerToProject } from "@/lib/bible-data/versification"
import type { BkpStructureLayer, BkpTextLayer, BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import {
  bibleChecksEnabled,
  bibleChecksGateFor,
  bookOfCells,
  buildCellCheckContexts,
  type BibleChecksProject,
} from "@/lib/bible-data/check-context"
import type { BibleFileScanInput } from "@/lib/rules/bible-check-rules"
import { fileHasSections, type FileReference } from "@/lib/parsers/types"
import type { CellRefsInput } from "../../db/shared/bible-checks/compile"
import { bibleChecksReadText } from "../../db/shared/bible-checks/evaluate"

export type BibleChecksStatus = "off" | "dormant" | "loading" | "ready" | "unavailable"

export interface BibleChecksState {
  status: BibleChecksStatus
  /** The cell's check inputs, or undefined when the pack has nothing for it. */
  contextFor: (cellId: string) => CellCheckContext | undefined
  /** Changes whenever `contextFor` could answer differently. Feed it to useHealth. */
  signature: string
  /**
   * AQU-1697: what Check file's Bible data scans read (S1 headings, S8 verse
   * numbering), loaded when called. Null while the checks are off (the
   * enrichment, the Bible data experiment, or a file that is not a Bible
   * book), for a file with no verse refs, or when the pack does not load.
   */
  fileScan: () => Promise<BibleFileScanInput | null>
}

type LoadedLayers =
  | {
      book: string
      ok: true
      version: string
      voices: BkpVoicesLayer
      structure: BkpStructureLayer | null
      text: BkpTextLayer | null
    }
  | { book: string; ok: false }

/** FNV-1a: a short, stable stand-in for a long refs key inside a signature. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const NO_CONTEXTS: ReadonlyMap<string, CellCheckContext> = new Map()

export function useBibleChecks(
  project: BibleChecksProject | null | undefined,
  cells: readonly CellRefsInput[],
  /** The open file. The checks run only on one with scripture sections. */
  file: Pick<FileReference, "type" | "hasScriptureContent"> | null | undefined,
): BibleChecksState {
  // Keyed on a boolean and a string, so a new project object with the same
  // settings does not recompile anything.
  const enabled = bibleChecksEnabled(project) && !!file && fileHasSections(file)
  const profileKey = JSON.stringify(project?.languageProfile ?? null)
  const gate = useMemo(() => bibleChecksGateFor(enabled, JSON.parse(profileKey)), [enabled, profileKey])

  // The compile reads ids and refs only. Keying it on this string keeps cell
  // text (which changes on every keystroke) out of its inputs.
  const refsKey = useMemo(
    () => JSON.stringify(cells.map((cell) => [cell.id, cell.globalReferences ?? []])),
    [cells],
  )
  const book = useMemo(() => bookOfCells(JSON.parse(refsKey).map(toCell)), [refsKey])

  const [layers, setLayers] = useState<LoadedLayers | null>(null)
  const active = gate.state === "on" && book !== null
  const readsText = gate.state === "on" && bibleChecksReadText(gate.profile)
  useEffect(() => {
    if (!active || book === null) return
    let cancelled = false
    const text = readsText ? loadLayer("text", book) : Promise.resolve(null)
    void Promise.all([loadManifest(), loadLayer("voices", book), loadLayer("structure", book), text]).then(
      ([manifest, voices, structure, textLayer]) => {
        if (cancelled) return
        if (!voices.ok) {
          setLayers({ book, ok: false })
          return
        }
        setLayers({
          book,
          ok: true,
          version: manifest.ok ? manifest.value.version : "",
          voices: mapLayerToProject(voices.value),
          structure: structure.ok ? mapLayerToProject(structure.value) : null,
          // The text layer is best effort: without it the number checks have no facts.
          text: textLayer?.ok ? mapLayerToProject(textLayer.value) : null,
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [active, book, readsText])

  const current = layers && layers.book === book ? layers : null
  const contexts = useMemo(() => {
    if (gate.state !== "on" || !current?.ok) return NO_CONTEXTS
    const refCells = (JSON.parse(refsKey) as [string, string[]][]).map(toCell)
    return buildCellCheckContexts(refCells, current.voices, current.structure, gate.profile, current.text)
  }, [gate, current, refsKey])

  const contextFor = useCallback((cellId: string) => contexts.get(cellId), [contexts])

  let status: BibleChecksStatus
  if (gate.state !== "on") status = gate.state
  else if (book === null || current?.ok === false) status = "unavailable"
  else status = current ? "ready" : "loading"

  const signature =
    status === "ready" && current?.ok
      ? `bkp:${current.version}|${book}|${hash(profileKey)}|${hash(refsKey)}|${current.text ? "text" : "no-text"}`
      : status

  const fileScan = useCallback(async (): Promise<BibleFileScanInput | null> => {
    if (gate.state === "off" || book === null) return null
    const structure = await loadLayer("structure", book)
    return structure.ok ? { structure: mapLayerToProject(structure.value), profile: gate.profile } : null
  }, [gate, book])

  return { status, contextFor, signature, fileScan }
}

function toCell([id, globalReferences]: [string, string[]]): CellRefsInput {
  return { id, globalReferences }
}
