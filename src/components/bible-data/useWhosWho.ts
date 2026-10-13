// Who's Who in the editor (AQU-1689): the table-level half.
//
// EditorTable calls this (through useBibleData) once per render. It:
//   • loads the pack's `people` layer for the open book, with `text` and,
//     for Who's Who, `structure`, only while Who's Who or the Context tab
//     (Original-language context) is on;
//   • builds the people index once per (pack version, book);
//   • names participants through the label chain;
//   • turns "go to JHN 4:9" (a popover's next mention, the panel's first
//     mention) into a scroll to the first cell of that verse.
// Rows read the result through WhosWhoContext. Nothing here throws: an
// unavailable pack means no tints, no Context tab, and an empty panel.
//
// AQU-1694: while Who's Who highlights are on, it also loads the file's
// stored word alignment (Bridge 1, for a source that is not the pack's own
// words) and runs Bridge 2 (source → target) for the target column's tints.
//
// AQU-1695: it names each mention (a deity's form at that word, when the pack
// gives one) and tells the Context tab whether to show Translation helps and
// key terms; the tab loads those layers itself, when it first opens.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
import { entityOf, peopleIndexFor, type MentionAt, type PeopleIndex } from "@/lib/bible-data/people-index"
import { cellVerses, firstVerseBook, type VoiceCellInput } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
import { onMentionJumpRequest } from "./bible-data-bus"
import { createMentionHighlightStore } from "./mention-highlight-store"
import { deityFormName, participantName } from "./people-text"
import { usePeoplePack } from "./people-pack"
import { ensureSourceAlignment, useSourceAlignment } from "./source-alignment-store"
import { createTargetBridge, type TargetBridge, type TargetCorpusCell } from "./target-bridge"
import { useEntityLabels, useLabelText, type EntityLabeler } from "./useEntityLabels"
import type { WhosWhoContextValue } from "./whos-who-context"

export interface WhosWhoOptions {
  project: ProjectRecord
  /** The file's cells as verses, by position (see useVerseCells). */
  cells: readonly VoiceCellInput[]
  cellIds: readonly string[]
  shared: ReadonlySet<BkpRef>
  fileId: string | null
  /** The project's Who's Who enrichment is on. */
  whosWhoOn: boolean
  /** The project's Original-language context enrichment (the Context tab) is on. */
  contextOn: boolean
  /** AQU-1695: Translation helps is on (notes and questions in the Context tab). */
  helpsOn: boolean
  /** AQU-1695: Key terms is on (term chips in the Context tab). */
  termsOn: boolean
  /** Scroll the editor to a cell. */
  jumpToCell: (cellId: string) => void
  showMentionsOf: (entity: BkpEntityId) => void
  /** Sync tokens; without one, no stored alignment is read (Bridge 1). */
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** The file's cells with both texts, read when Bridge 2 runs; without it, no target tints. */
  targetCorpus?: () => readonly TargetCorpusCell[]
}

export interface WhosWho {
  context: WhosWhoContextValue | null
  index: PeopleIndex | null
  nameOf: ((entityId: BkpEntityId) => string) | null
}

export function useWhosWho({
  project,
  cells,
  cellIds,
  shared,
  fileId,
  whosWhoOn,
  contextOn,
  helpsOn,
  termsOn,
  jumpToCell,
  showMentionsOf,
  getTokenForFile,
  targetCorpus,
}: WhosWhoOptions): WhosWho {
  const t = useT()
  const fmt = useFormat()
  const prefs = useBibleDataViewPrefs()
  const enabled = whosWhoOn || contextOn
  const book = useMemo(() => (enabled ? firstVerseBook(cells) : null), [enabled, cells])
  const pack = usePeoplePack(book, { structure: whosWhoOn, text: true })
  const loaded = pack?.ok ? pack : null

  const index = useMemo(
    () => (loaded ? peopleIndexFor(loaded.version, loaded.people, loaded.structure, loaded.text) : null),
    [loaded],
  )
  const labelFor: EntityLabeler | null = useEntityLabels(project, loaded ? loaded.people.entities : null)
  const nameOf = useMemo(() => {
    if (!index || !labelFor) return null
    const unnamed = t("bibleData.whosWho.unknownParticipant")
    return (entityId: BkpEntityId): string =>
      participantName(entityId, index.entities, labelFor, (items) => fmt.list(items, { type: "conjunction" })) ?? unnamed
  }, [index, labelFor, fmt, t])
  const pickText = useLabelText()
  const mentionName = useMemo(() => {
    if (!index || !nameOf) return null
    return (at: MentionAt): string =>
      deityFormName(at.mention, entityOf(index, at.mention.entity), pickText) ?? nameOf(at.mention.entity)
  }, [index, nameOf, pickText])

  const [store] = useState(createMentionHighlightStore)

  // The first cell of each verse, in file order: where a jump to that verse lands.
  const firstCellOfVerse = useMemo(() => {
    const out = new Map<BkpRef, string>()
    cells.forEach((cell, position) => {
      for (const ref of cellVerses(cell)?.refs ?? []) {
        if (!out.has(ref) && position < cellIds.length) out.set(ref, cellIds[position])
      }
    })
    return out
  }, [cells, cellIds])

  const jumpTo = useCallback(
    (ref: BkpRef, focus?: BkpEntityId) => {
      const cellId = firstCellOfVerse.get(ref)
      if (!cellId) return
      if (focus) store.requestFocus({ cellId, entity: focus })
      jumpToCell(cellId)
    },
    [firstCellOfVerse, jumpToCell, store],
  )

  // The Who's Who panel asks for jumps by verse.
  useEffect(() => {
    if (!fileId || !whosWhoOn) return
    return onMentionJumpRequest(fileId, (ref) => jumpTo(ref))
  }, [fileId, whosWhoOn, jumpTo])

  // Bridge 1: the file's stored alignment, while highlights are on.
  const highlightsOn = whosWhoOn && prefs.whosWhoHighlights !== "off"
  const projectId = project.id
  useEffect(() => {
    if (!highlightsOn || !fileId || !getTokenForFile) return
    ensureSourceAlignment(projectId, fileId, getTokenForFile)
  }, [highlightsOn, projectId, fileId, getTokenForFile])
  const alignment = useSourceAlignment(highlightsOn && getTokenForFile ? projectId : null, fileId)
  const sourceLinks = alignment.status.kind === "ready" ? alignment.status.cells : null

  // Bridge 2: one per editor and file, while highlights are on and the table offers its cells.
  const targetBridge = useMemo<TargetBridge | null>(
    () => (highlightsOn && fileId && targetCorpus ? createTargetBridge({ corpus: targetCorpus }) : null),
    [highlightsOn, fileId, targetCorpus],
  )
  // Releases the bridge's worker; the bridge stays usable (StrictMode re-runs this).
  useEffect(() => () => targetBridge?.dispose(), [targetBridge])

  const context = useMemo<WhosWhoContextValue | null>(
    () =>
      index && labelFor && nameOf && mentionName
        ? {
            index,
            text: loaded?.text ?? null,
            labelFor,
            nameOf,
            mentionName,
            store,
            highlights: whosWhoOn ? prefs.whosWhoHighlights : "off",
            hints: whosWhoOn ? prefs.impliedSubjectHints : "off",
            contextTab: contextOn,
            helps: contextOn && helpsOn,
            terms: contextOn && termsOn,
            shared,
            jumpTo,
            showMentionsOf: whosWhoOn ? showMentionsOf : null,
            bridges: { source: highlightsOn ? sourceLinks : null, target: highlightsOn ? targetBridge : null },
          }
        : null,
    [
      index,
      labelFor,
      nameOf,
      mentionName,
      loaded,
      store,
      whosWhoOn,
      contextOn,
      helpsOn,
      termsOn,
      prefs.whosWhoHighlights,
      prefs.impliedSubjectHints,
      shared,
      jumpTo,
      showMentionsOf,
      highlightsOn,
      sourceLinks,
      targetBridge,
    ],
  )

  return { context, index: enabled ? index : null, nameOf }
}
