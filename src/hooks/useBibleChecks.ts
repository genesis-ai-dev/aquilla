// Bible data checks for the open file (AQU-1688).
//
// Loads the book's voices and structure layers through the pack client (once
// per session; IndexedDB keeps them offline), compiles every cell's
// expectation once per file, and hands the rule engine a per-cell lookup. The
// compile is keyed by pack version, the cells' refs and the Language profile,
// never by cell text, so typing in one cell re-checks only that cell.
//
// Nothing is fetched while the checks are off or dormant. AQU-1697: the text
// layer (several MB) loads only while a check that reads it can run (numbers,
// negation, run-on sentences), and `fileScan` loads the structure layer for
// Check file's scans (headings, verse numbering) when it runs.
//
// AQU-1699 (check pack B): the people layer loads while a participant check can
// run, and the compile also takes the project's decisions (`projectFacts`),
// its terminology and its source language, which give each name its agreed
// rendering. `fileScan` adds what the name and quotation scans read.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { CellCheckContext } from "@/lib/rules/rule-engine"
import { loadLayer, loadManifest } from "@/lib/bible-data/pack-client"
import { mapLayerToProject } from "@/lib/bible-data/versification"
import type { BkpPeopleLayer, BkpStructureLayer, BkpTextLayer, BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import {
  bibleChecksEnabled,
  bibleChecksGateFor,
  bookOfCells,
  buildCellCheckContexts,
  isMultiLaneProject,
  type BibleChecksProject,
} from "@/lib/bible-data/check-context"
import type { BibleFileScanInput } from "@/lib/rules/bible-check-rules"
import { readProjectFacts } from "../../db/shared/project-facts"
import { buildNameTable, readinessFromDecisions } from "../../db/shared/bible-checks/agreed-names"
import type { CellRefsInput } from "../../db/shared/bible-checks/compile"
import { bibleChecksReadPeople, bibleChecksReadText } from "../../db/shared/bible-checks/evaluate"
import type { ConceptInput } from "../../db/shared/bible-checks/participant-types"
import type { CellExpectation } from "../../db/shared/bible-checks/types"

export type BibleChecksStatus = "off" | "dormant" | "loading" | "ready" | "unavailable"

export interface BibleChecksState {
  status: BibleChecksStatus
  /** The cell's check inputs, or undefined when the pack has nothing for it. */
  contextFor: (cellId: string) => CellCheckContext | undefined
  /** Changes whenever `contextFor` could answer differently. Feed it to useHealth. */
  signature: string
  /**
   * AQU-1697: what Check file's Bible data scans read (S1 headings, S8 verse
   * numbering; AQU-1699: P2 names, X3 repeated quotations), loaded when called.
   * Null while the checks enrichment is off, for a file with no verse refs, or
   * when the pack does not load.
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
      people: BkpPeopleLayer | null
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
const NO_CONCEPTS: readonly ConceptInput[] = []

export function useBibleChecks(
  project: BibleChecksProject | null | undefined,
  cells: readonly CellRefsInput[],
  /** AQU-1699: the project's terminology (the concepts projection); entries that name someone give agreed names. */
  concepts: readonly ConceptInput[] = NO_CONCEPTS,
): BibleChecksState {
  // Keyed on a boolean and strings, so a new project object with the same
  // settings does not recompile anything.
  const enabled = bibleChecksEnabled(project)
  const profileKey = JSON.stringify(project?.languageProfile ?? null)
  const factsKey = JSON.stringify(project?.projectFacts ?? null)
  const conceptsKey = useMemo(
    () => JSON.stringify(concepts.map((c) => [c.id, c.sourceTerm, c.status, c.renderings, c.externalIds?.acai ?? null])),
    [concepts],
  )
  const sourceLanguage = project?.sourceLanguage ?? null
  const multiLane = isMultiLaneProject(project)
  const facts = useMemo(() => readProjectFacts(JSON.parse(factsKey)), [factsKey])
  const conceptInputs = useMemo(() => (JSON.parse(conceptsKey) as ConceptRow[]).map(toConcept), [conceptsKey])
  const readiness = useMemo(() => readinessFromDecisions(facts, conceptInputs), [facts, conceptInputs])
  const gate = useMemo(() => bibleChecksGateFor(enabled, JSON.parse(profileKey), readiness), [enabled, profileKey, readiness])

  // The compile reads ids and refs only. Keying it on this string keeps cell
  // text (which changes on every keystroke) out of its inputs.
  const refsKey = useMemo(
    () => JSON.stringify(cells.map((cell) => [cell.id, cell.globalReferences ?? []])),
    [cells],
  )
  const book = useMemo(() => bookOfCells(JSON.parse(refsKey).map(toCell)), [refsKey])

  const [layers, setLayers] = useState<LoadedLayers | null>(null)
  const active = gate.state === "on" && book !== null
  const readsText = gate.state === "on" && bibleChecksReadText(gate.profile, readiness)
  const readsPeople = gate.state === "on" && bibleChecksReadPeople(gate.profile, readiness)
  useEffect(() => {
    if (!active || book === null) return
    let cancelled = false
    const text = readsText ? loadLayer("text", book) : Promise.resolve(null)
    const people = readsPeople ? loadLayer("people", book) : Promise.resolve(null)
    void Promise.all([loadManifest(), loadLayer("voices", book), loadLayer("structure", book), text, people]).then(
      ([manifest, voices, structure, textLayer, peopleLayer]) => {
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
          // So is the people layer: without it check pack B has no facts.
          people: peopleLayer?.ok ? mapLayerToProject(peopleLayer.value) : null,
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [active, book, readsText, readsPeople])

  const current = layers && layers.book === book ? layers : null
  const names = useMemo(() => {
    if (!current?.ok || !current.people) return null
    return buildNameTable({ people: current.people, text: current.text, facts, concepts: conceptInputs, sourceLanguage, multiLane })
  }, [current, facts, conceptInputs, sourceLanguage, multiLane])

  const contexts = useMemo(() => {
    if (gate.state !== "on" || !current?.ok) return NO_CONTEXTS
    const refCells = (JSON.parse(refsKey) as [string, string[]][]).map(toCell)
    const participants = current.people && names ? { people: current.people, names } : null
    return buildCellCheckContexts(refCells, current.voices, current.structure, gate.profile, current.text, participants)
  }, [gate, current, refsKey, names])

  const contextFor = useCallback((cellId: string) => contexts.get(cellId), [contexts])

  let status: BibleChecksStatus
  if (gate.state !== "on") status = gate.state
  else if (book === null || current?.ok === false) status = "unavailable"
  else status = current ? "ready" : "loading"

  const signature =
    status === "ready" && current?.ok
      ? `bkp:${current.version}|${book}|${hash(profileKey)}|${hash(refsKey)}|${current.text ? "text" : "no-text"}` +
        `|${current.people ? "people" : "no-people"}|${hash(factsKey + conceptsKey)}|${sourceLanguage ?? ""}|${multiLane ? "lanes" : "lane"}`
      : status

  const fileScan = useCallback(async (): Promise<BibleFileScanInput | null> => {
    if (gate.state === "off" || book === null) return null
    // X3 compares the Greek of repeated quotations, so Check file reads the voices and text layers too.
    const [structure, voices, text] = await Promise.all([loadLayer("structure", book), loadLayer("voices", book), loadLayer("text", book)])
    if (!structure.ok) return null
    const expectations = new Map<string, CellExpectation>()
    for (const [cellId, context] of contexts) if (context.bible) expectations.set(cellId, context.bible.expectation)
    return {
      structure: mapLayerToProject(structure.value),
      profile: gate.profile,
      voices: voices.ok ? mapLayerToProject(voices.value) : null,
      text: text.ok ? mapLayerToProject(text.value) : null,
      expectations,
      readiness: names?.readiness ?? readiness,
    }
  }, [gate, book, contexts, names, readiness])

  return { status, contextFor, signature, fileScan }
}

function toCell([id, globalReferences]: [string, string[]]): CellRefsInput {
  return { id, globalReferences }
}

/** The fields of a terminology entry the name lookup reads, as `conceptsKey` holds them. */
type ConceptRow = [id: string, sourceTerm: string, status: string, renderings: ConceptInput["renderings"], acai: string | null]

function toConcept([id, sourceTerm, status, renderings, acai]: ConceptRow): ConceptInput {
  return { id, sourceTerm, status, renderings, ...(acai ? { externalIds: { acai } } : {}) }
}
