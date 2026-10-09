/**
 * Smart Extensions, apiRev 4: the last built-in editor surfaces, lent to an
 * `editor` extension for the open file — per-take audio validation, the Audio
 * lens's take (peaks, trim, voice, cloning), source editing and the cell menu,
 * the AI surfaces beside a cell (translation-memory examples, autopilot
 * drafts, smart edits) and the source selection toolbar. Pure assembly over
 * the handlers and helpers the built-in editor uses (EditorTable,
 * CellVoicePanel, ExamplePanel, ContextualDraftCard, SourceSelectionToolbar),
 * so the two editors decide the same things the same way. Writes carry the
 * extension's `tool_origin` where the event supports it.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { CellData } from "@/hooks/useCells"
import type { CellStore } from "@/hooks/useActiveCellStore"
import { readAtVersion } from "@/hooks/useActiveCellStore"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import { useSmartEditsPassage } from "@/hooks/useSmartEdits"
import { useEditorCapabilities } from "@/hooks/useProjectPermissions"
import { useDcsUpstreamCursor } from "@/hooks/useDcsUpstreamCursor"
import { applyRowOverlays } from "@/components/EditorTable"
import { fmtClock } from "@/components/timeline/format"
import { useT } from "@/lib/i18n/I18nProvider"
import { canPerform } from "@/lib/sync/role-policy"
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"
import { emitCellAudioUnvalidate, emitCellAudioValidate, emitSourceCellCommit } from "@/lib/sync/events-emit"
import { useAudioValidationCommit } from "@/lib/audio/audio-validation-commit"
import { audioBlockedReason, lineValidationTakes } from "@/lib/audio/audio-validation-permissions"
import { audioColumnFor, fileHasAudio, fileLastSeenWithAudio } from "@/lib/audio/file-has-audio"
import { readValidationCountAudio } from "@/lib/progress/read-validation-count"
import { takeTrackName } from "@/lib/timeline/take-colors"
import { keptWindowSec } from "@/lib/audio/kept-window"
import { loadPeaksFor, type SyncTokenFetcher } from "@/lib/audio/peaks-loader"
import { persistTakeTrim } from "@/lib/audio/persist-trim"
import { assignedCastVoiceId, findVoice, getVoiceLibrary, resolveCastVoice } from "@/lib/audio/voices"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { LinkedTake } from "@/lib/audio/linked-takes"
import { diffSourceTokens, rankTmMatches } from "@/lib/search/fuzzy-match"
import type { ScoredPair } from "@/lib/search/dual-index"
import { effectiveSourceText, sourceCommitFields } from "@/lib/cell-text"
import { resolveSourceCommitParent, reconcilePendingSourceCommit, type PendingSourceCommit } from "@/lib/sync/source-commit-chain"
import { getContextualDraftFor, resolveContextualDraft, useContextualDrafts } from "@/lib/contextual/drafts-store"
import { reviewContextualDraft } from "@/lib/contextual/transport"
import { isAutopilotVisible, isFlagEnabled } from "@/lib/features/flags"
import { hasSourceTermMatch } from "@/lib/terminology/source-lookup"
import { buildSourceChip, type ContextChip } from "@/lib/agent/context-chip"
import type { Concept, ConceptDraft, TermMatchingSettings } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ToolRev4Services } from "@/lib/tools/host-handlers-rev4"
import type { ToolOrigin } from "../../../shared/tools/manifest"
import type { ToolAudioTake, ToolExample, ToolSmartEdit, ToolSourceActions, ToolVoiceTake } from "../../../shared/tools/editor-api-rev4"
import { ExtensionTermPopovers, type ExtensionTermRequest } from "./ExtensionTermPopovers"

type InsertSpan = { startSec: number; endSec: number }
interface SourceLineEditing {
  head: InsertSpan | null
  afterCell: ReadonlyMap<string, InsertSpan>
  untimed?: boolean
  rowActions: (cell: CellData, gaps: { gapAbove: boolean; gapBelow: boolean }) => { above: string | null; below: string | null; remove: string | null }
}

export interface ExtensionEditorRev4Args {
  enabled: boolean
  project: ProjectRecord | null
  fileId: string | null
  lane: string
  store: CellStore
  storeVersion: number
  username: string
  isTimeOrdered: boolean
  jwt: string | null
  getSyncToken: SyncTokenFetcher
  // Source selection toolbar
  concepts: Concept[]
  termMatching?: TermMatchingSettings
  addConceptBlockedReason: string | null
  canApproveConcept: boolean
  onAddConcept: (draft: ConceptDraft) => void | Promise<void>
  onViewConcept: (conceptId: string) => void
  onSetUpAffixes?: () => void
  onAskAi: (chip: ContextChip) => void
  fileName: string
  // AI surfaces
  examples: Map<string, ScoredPair[]>
  exampleOrigin: (fileId: string) => { fileName: string; isTranslationMemory: boolean } | null
  commitTarget: (cellId: string, snapshot: { value: string; valueHtml: string }, origin?: ToolOrigin) => Promise<unknown>
  // Source menu
  sourceLineEditing?: SourceLineEditing
  onInsertCellBeside: (cellId: string, side: "above" | "below") => void
  onAddLineAt: (startSec: number, endSec: number) => void
  onRemoveCell: (cellId: string) => void
  onSetCellHidden: (cellId: string, hidden: boolean) => void
  onRetimeCell: (cellId: string, startSec: number, endSec: number) => void
  timingLocked: boolean
  canUnlockTiming: boolean
  onCellCommitted?: (cellId: string) => void
  // Audio
  myScopes: MemberScope[]
  linkedTakesByCell?: ReadonlyMap<string, readonly LinkedTake[]>
  ttsSettings: ProjectTtsSettings | undefined
  onAssignCastVoice: (cell: CellData, voiceId: string) => void
  onClearCastVoice: (cell: CellData) => void
  onCloneVoice: (cellId: string) => void
}

export interface ExtensionEditorRev4 {
  services: ToolRev4Services
  /** Bumps that the host pushes as events (audio.changed, contextual.changed, smartedits.changed). */
  versions: { audio: unknown; contextual: unknown; smartEdits: unknown; examples: unknown }
  overlay: ReactNode
}

const PEAK_BUCKETS = 160

export function useExtensionEditorRev4(args: ExtensionEditorRev4Args): ExtensionEditorRev4 {
  const t = useT()
  const argsRef = useRef(args)
  useEffect(() => { argsRef.current = args })
  const projectId = args.project?.id ?? ""
  const fileId = args.enabled ? args.fileId : null
  const roleLevel = args.project?.syncRole?.level ?? null

  // ── Source editing permissions (EditorTable's useEditorCapabilities) ──────
  const { cursor: dcsCursor, loading: dcsLoading } = useDcsUpstreamCursor(projectId, roleLevel)
  const caps = useEditorCapabilities(args.project as ProjectRecord, { hasDcsUpstream: dcsLoading || dcsCursor !== null })
  const capsRef = useRef(caps)
  useEffect(() => { capsRef.current = caps })

  // ── Audio: the file's takes, as the built-in table reads them ─────────────
  const { byCellId: audioByCellId, hasLoaded: audioLoaded } = useFileAudioAttachments(projectId, fileId, args.lane)
  const audioRef = useRef({ audioByCellId, audioLoaded })
  useEffect(() => { audioRef.current = { audioByCellId, audioLoaded } })
  const commitAudioValidation = useAudioValidationCommit(args.jwt)
  const peaks = useRef(new Map<string, number[]>())

  // ── Smart edits (flag-gated, as in EditorTable) ───────────────────────────
  const [activeCellId, setActiveCellId] = useState<string | null>(null)
  const smartEnabled = Boolean(args.enabled && args.project && isFlagEnabled(args.project, "smartEdits"))
  const cellIds = useMemo(
    () => (smartEnabled ? readAtVersion(args.storeVersion, () => args.store.getCellIds()) : []),
    [smartEnabled, args.store, args.storeVersion],
  )
  const smart = useSmartEditsPassage({
    enabled: smartEnabled,
    llmEnabled: false,
    harmonizerEnabled: Boolean(smartEnabled && args.project && isFlagEnabled(args.project, "harmonizer")),
    projectId,
    lane: args.lane,
    cellIds,
    activeCellId,
    activeText: readAtVersion(args.storeVersion, () => (activeCellId ? args.store.getCellView(activeCellId)?.translated : undefined)),
    getCell: (id) => {
      const view = args.store.getCellView(id)
      return view
        ? { fileId: view.fileId, cellId: id, source: effectiveSourceText(view), target: view.translated, ...(view.context ? { ref: view.context } : {}), validated: view.status === "validated" }
        : null
    },
  })
  const smartStore = smart?.store
  const smartVersion = useSyncExternalStore(smartStore?.subscribe ?? noopSubscribe, smartStore?.getVersion ?? zero, zero)
  const smartRef = useRef(smart)
  useEffect(() => { smartRef.current = smart })

  // ── Autopilot drafts ──────────────────────────────────────────────────────
  const contextual = useContextualDrafts()

  // ── Source commits: the head chain per cell (EditorTable's pendingSourceCommitRef)
  const pendingSource = useRef(new Map<string, PendingSourceCommit | null>())

  // ── Term popovers over the frame ──────────────────────────────────────────
  const [termRequest, setTermRequest] = useState<ExtensionTermRequest | null>(null)

  const services = useMemo<ToolRev4Services>(() => {
    const a = () => argsRef.current
    const view = (cellId: string): CellData => {
      const v = a().store.getCellView(cellId)
      if (!v) throw Object.assign(new Error("no such cell in this file"), { code: "not_found" })
      return v
    }
    const withAudio = (cellId: string): CellData => {
      const { audioByCellId: audio } = audioRef.current
      return applyRowOverlays(view(cellId), { audioEntry: audio.get(cellId), projectId: a().project?.id ?? null, lane: a().lane })
    }
    const lineTakes = (cell: CellData) => {
      const args_ = a()
      return lineValidationTakes(
        cell,
        args_.linkedTakesByCell?.get(cell.id) ?? null,
        args_.project as ProjectRecord,
        { roleLevel: args_.project?.syncRole?.level ?? null, username: args_.username },
        audioBlockedReason(t),
        (cue) => cue.original?.trim()
          ? `“${cue.original.trim()}”`
          : t("editor.audio.heardLineAt", { range: `${fmtClock(cue.startTime ?? 0, true)}–${fmtClock(cue.endTime ?? cue.startTime ?? 0, true)}` }),
        (_owner, slot) => takeTrackName({ files: args_.project?.files ?? [], fileId: cell.fileId, slot }) ?? t("editor.recordingTab.addedTrack"),
      )
    }
    const playableOf = (cell: CellData): string | undefined => {
      for (const id of [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]) {
        const att = id ? cell.attachments?.[id] : undefined
        if (id && att && !att.isDeleted) return id
      }
      return undefined
    }

    return {
      // ── 39: per-take audio validation ─────────────────────────────────────
      audioTakes: async () => {
        const args_ = a()
        const { audioByCellId: audio, audioLoaded: loaded } = audioRef.current
        const hasAudio = fileHasAudio(loaded ? audio : null, args_.linkedTakesByCell ?? null)
        const key = args_.fileId ? `${args_.project?.id}/${args_.fileId}` : null
        const column = audioColumnFor({ hasAudio, checking: !loaded, expectAudio: key !== null && fileLastSeenWithAudio(key) })
        const takes: Record<string, ToolAudioTake[]> = {}
        if (column === "on") {
          for (const cellId of args_.store.getCellIds()) {
            const line = lineTakes(withAudio(cellId))
            if (line.takes.length) {
              takes[cellId] = line.takes.map((tk) => ({
                audioId: tk.audioId, label: tk.label, slot: tk.slot ?? "recording", validators: [...tk.validators], validatorCount: tk.validatorCount,
                isGenerated: tk.isGenerated, canValidate: tk.canValidate, blockedReason: tk.blockedReason ?? null, unrecorded: tk.unrecorded === true,
              }))
            }
          }
        }
        return { column, requirement: readValidationCountAudio(args_.project as ProjectRecord), takes }
      },
      validateAudio: async (_f, cellId, audioId, validated) => {
        const args_ = a()
        const kind = validated ? "cell.audio.validate" : "cell.audio.unvalidate"
        if (!canPerform(kind, args_.project?.syncRole?.level ?? null)) throw Object.assign(new Error("your role cannot validate audio here"), { code: "permission_denied" })
        const cell = withAudio(cellId)
        if (!isInMemberScope(args_.myScopes, cell.fileId, args_.lane)) throw Object.assign(new Error("this cell is outside your assignment"), { code: "permission_denied" })
        const owner = lineTakes(cell).ownerOf.get(audioId) ?? { fileId: cell.fileId, cellId: cell.id }
        const emit = validated ? emitCellAudioValidate : emitCellAudioUnvalidate
        await emit({ projectId: args_.project!.id, fileId: owner.fileId, cellId: owner.cellId, audioId, ...(args_.lane ? { targetLang: args_.lane } : {}), author: args_.username, surface: "cell" })
        await commitAudioValidation([owner.fileId])
        return true
      },
      // ── 71: the Audio lens's take ─────────────────────────────────────────
      voiceTake: async (_f, cellId) => {
        const args_ = a()
        const cell = withAudio(cellId)
        const id = playableOf(cell)
        const att = id ? cell.attachments?.[id] : undefined
        if (!id || !att) return null
        const kept = keptWindowSec(cell, id, att)
        let bars = peaks.current.get(id)
        if (!bars && att.url) {
          const p = await loadPeaksFor({ attachmentKey: id, url: att.url, projectId: args_.project!.id, fileId: cell.fileId, bins: PEAK_BUCKETS, getSyncToken: args_.getSyncToken }).catch(() => null)
          if (p) {
            let max = 0
            for (const v of p) max = Math.max(max, Math.abs(v))
            bars = Array.from(p, (v) => (max ? Math.round((Math.abs(v) / max) * 1000) / 1000 : 0))
            peaks.current.set(id, bars)
          }
        }
        const isGenerated = id === cell.selectedGeneratedVoiceAudioId && kept.kind !== "section"
        const lineVoice = resolveCastVoice(args_.ttsSettings, cell.id, cell.ttsSettings?.voiceId)
        const takeVoice = isGenerated && att.voiceId && att.voiceId !== lineVoice.id ? findVoice(args_.ttsSettings, att.voiceId) : undefined
        const out: ToolVoiceTake = {
          audioId: id,
          durationMs: att.durationMs ?? 0,
          trimStartMs: att.trimStartMs ?? null,
          trimEndMs: att.trimEndMs ?? null,
          trimmable: kept.kind !== "section",
          peaks: bars ?? [],
          isGenerated,
          takeVoiceName: takeVoice?.name ?? null,
        }
        return out
      },
      trimAudio: async (_f, cellId, audioId, startMs, endMs) => {
        const args_ = a()
        const cell = withAudio(cellId)
        const att = cell.attachments?.[audioId]
        if (!att) return false
        if (keptWindowSec(cell, audioId, att).kind === "section") return false
        await persistTakeTrim({
          projectId: args_.project!.id, fileId: cell.fileId, cellId: cell.id, audioId, att, selectedAudioId: cell.selectedAudioId,
          trimStartMs: startMs > 0 ? startMs : null, trimEndMs: endMs, ...(args_.lane ? { targetLang: args_.lane } : {}), author: args_.username,
        })
        return true
      },
      voices: async () => {
        const args_ = a()
        const current: Record<string, { id: string; name: string; explicit: boolean }> = {}
        for (const cellId of args_.store.getCellIds()) {
          const cell = args_.store.getCellView(cellId)
          if (!cell) continue
          const v = resolveCastVoice(args_.ttsSettings, cellId, cell.ttsSettings?.voiceId)
          current[cellId] = { id: v.id, name: v.name, explicit: Boolean(findVoice(args_.ttsSettings, assignedCastVoiceId(args_.ttsSettings, cellId) ?? cell.ttsSettings?.voiceId)) }
        }
        return { voices: getVoiceLibrary(args_.ttsSettings).map((v) => ({ id: v.id, name: v.name })), current, canClone: true }
      },
      assignVoice: async (_f, cellId, voiceId) => {
        const cell = view(cellId)
        if (voiceId) a().onAssignCastVoice(cell, voiceId)
        else a().onClearCastVoice(cell)
        return true
      },
      cloneVoice: async (_f, cellId) => {
        a().onCloneVoice(cellId)
        return true
      },
      // ── 52: source editing and the cell menu ──────────────────────────────
      sourceActions: async (_f, cellId) => {
        const args_ = a()
        const cell = view(cellId)
        const cap = capsRef.current
        const idml = Boolean((cell.metadata as { idml?: unknown } | undefined)?.idml)
        const out: ToolSourceActions = {}
        // As CellSourceMenu: offered when editable, explained when refused for
        // a reason worth stating (IDML, a DCS pin), absent otherwise.
        if (cap.canEditSource && !idml) out.edit = null
        else if (idml) out.edit = t("editor.source.idmlProtected")
        else if (cap.sourceReadOnlyReason) out.edit = cap.sourceReadOnlyReason
        if (canPerform("source.cell.visibility.set", args_.project?.syncRole?.level ?? null)) {
          out.hide = { reason: cap.canEditSource ? null : cap.sourceReadOnlyReason, hidden: cell.hidden === true }
        }
        const timed = typeof cell.startTime === "number" && typeof cell.endTime === "number"
        if (args_.isTimeOrdered && timed) {
          const userAdded = Boolean((cell.metadata as { userAdded?: unknown } | undefined)?.userAdded)
          const reason = (cell.medium ?? "text") === "media" ? t("editor.row.mediaRemoveReason") : idml ? t("editor.row.idmlReason") : args_.timingLocked && !userAdded ? t("editor.cellMenu.timingLocked") : null
          out.timestamps = { reason, startSec: cell.startTime ?? 0, endSec: cell.endTime ?? 0, canUnlock: Boolean(args_.timingLocked && args_.canUnlockTiming && reason === t("editor.cellMenu.timingLocked")) }
        }
        const sle = args_.sourceLineEditing
        if (sle) {
          const ids = args_.store.getCellIds()
          const i = ids.indexOf(cellId)
          const below = sle.untimed ? null : sle.afterCell.get(cellId) ?? null
          const above = sle.untimed ? null : i === 0 ? sle.head : i > 0 ? sle.afterCell.get(ids[i - 1]) ?? null : null
          const reasons = sle.rowActions(cell, { gapAbove: Boolean(above), gapBelow: Boolean(below) })
          out.insertAbove = reasons.above
          out.insertBelow = reasons.below
          out.remove = reasons.remove
        }
        return out
      },
      commitSource: async (_f, cellId, value, html, origin) => {
        const args_ = a()
        const cell = view(cellId)
        const idml = Boolean((cell.metadata as { idml?: unknown } | undefined)?.idml)
        if (!capsRef.current.canEditSource || idml || !canPerform("source.cell.commit", args_.project?.syncRole?.level ?? null)) {
          throw Object.assign(new Error(idml ? t("editor.source.idmlProtected") : capsRef.current.sourceReadOnlyReason ?? "source editing is not available"), { code: "permission_denied" })
        }
        const pending = reconcilePendingSourceCommit(pendingSource.current.get(cellId) ?? null, cell.sourceEventId ?? null)
        const parentId = resolveSourceCommitParent(pending, cell.sourceEventId ?? null)
        const eventId = await emitSourceCellCommit({
          projectId: args_.project!.id, fileId: cell.fileId, cellId, parentId,
          ...sourceCommitFields(cell, { value, valueHtml: html ?? value }),
          author: args_.username,
          toolOrigin: origin,
        })
        pendingSource.current.set(cellId, { eventId, parentId })
        args_.onCellCommitted?.(cellId)
        return true
      },
      setCellHidden: async (_f, cellId, hidden) => {
        if (!capsRef.current.canEditSource) throw Object.assign(new Error(capsRef.current.sourceReadOnlyReason ?? "not available"), { code: "permission_denied" })
        a().onSetCellHidden(cellId, hidden)
        return true
      },
      insertCell: async (_f, cellId, side) => {
        const args_ = a()
        const sle = args_.sourceLineEditing
        if (!sle) throw Object.assign(new Error("adding lines is not available here"), { code: "permission_denied" })
        const cell = view(cellId)
        const ids = args_.store.getCellIds()
        const i = ids.indexOf(cellId)
        if (sle.untimed) {
          args_.onInsertCellBeside(cellId, side)
          return true
        }
        const span = side === "below" ? sle.afterCell.get(cellId) : i === 0 ? sle.head : sle.afterCell.get(ids[i - 1])
        const reasons = sle.rowActions(cell, { gapAbove: side === "above" && Boolean(span), gapBelow: side === "below" && Boolean(span) })
        const reason = side === "above" ? reasons.above : reasons.below
        if (reason || !span) throw Object.assign(new Error(reason ?? "no room for a line here"), { code: "invalid_params" })
        args_.onAddLineAt(span.startSec, span.endSec)
        return true
      },
      removeCell: async (_f, cellId) => {
        const sle = a().sourceLineEditing
        if (!sle) throw Object.assign(new Error("removing lines is not available here"), { code: "permission_denied" })
        const reason = sle.rowActions(view(cellId), { gapAbove: false, gapBelow: false }).remove
        if (reason) throw Object.assign(new Error(reason), { code: "invalid_params" })
        // The host confirms (ConfirmActionDialog) when the line carries anything.
        a().onRemoveCell(cellId)
        return true
      },
      retimeCell: async (_f, cellId, startSec, endSec) => {
        if (!canPerform("cell.retime", a().project?.syncRole?.level ?? null)) throw Object.assign(new Error("your role cannot retime lines"), { code: "permission_denied" })
        a().onRetimeCell(cellId, startSec, endSec)
        return true
      },
      // ── 60: the AI surfaces beside a cell ─────────────────────────────────
      examples: async (_f, cellId) => {
        const args_ = a()
        const cell = view(cellId)
        const pairs = args_.examples.get(cellId) ?? []
        if (!pairs.length) return []
        const current = effectiveSourceText(cell)
        return rankTmMatches(current, pairs).map((m): ToolExample => {
          const origin = args_.exampleOrigin(m.fileId)
          return {
            band: m.band, percent: m.percent, source: m.source, target: m.target, fileName: origin?.fileName ?? null,
            isTranslationMemory: origin?.isTranslationMemory ?? false, canInsert: m.band === "exact" && Boolean(m.target.trim()),
            diff: m.band !== "example" && current ? diffSourceTokens(current, m.source).map((d) => ({ kind: d.kind, text: d.text })) : null,
          }
        })
      },
      contextualDrafts: async () => {
        const args_ = a()
        if (!args_.project || !isAutopilotVisible(args_.project) || !args_.fileId) return {}
        const out: Record<string, { draftId: string; text: string; spanLabel: string }> = {}
        for (const cellId of args_.store.getCellIds()) {
          const d = getContextualDraftFor(args_.project.id, args_.fileId, args_.lane, cellId)
          if (d) out[cellId] = { draftId: d.draftId, text: d.text, spanLabel: d.spanLabel }
        }
        return out
      },
      reviewContextual: async (_f, cellId, draftId, accept, origin) => {
        const args_ = a()
        const d = args_.fileId && args_.project ? getContextualDraftFor(args_.project.id, args_.fileId, args_.lane, cellId) : undefined
        if (!d || d.draftId !== draftId || !args_.project || !args_.fileId) return false
        if (accept) {
          // An ordinary commit; the projection reconciles the draft.
          await args_.commitTarget(cellId, { value: d.text, valueHtml: d.text }, origin)
          return true
        }
        await reviewContextualDraft(args_.project.id, draftId, "rejected")
        resolveContextualDraft(args_.project.id, args_.fileId, args_.lane, cellId, draftId, "rejected")
        return true
      },
      smartEdits: async (_f, cellId) => {
        setActiveCellId(cellId)
        const s = smartRef.current
        if (!s) return []
        const text = view(cellId).translated ?? ""
        return s.store.forCell(cellId, text).map((sg): ToolSmartEdit => ({
          id: smartEditId(sg), start: sg.start, end: sg.end, old: sg.old, new: sg.new, tier: sg.tier, reason: sg.reason ?? null, flagOnly: sg.flagOnly === true,
        }))
      },
      smartEditFeedback: async (_f, cellId, id, action) => {
        const s = smartRef.current
        if (!s) return false
        const sg = s.store.forCell(cellId, view(cellId).translated ?? "").find((x) => smartEditId(x) === id)
        if (!sg) return false
        s.feedback(sg, action)
        return true
      },
      // ── 61: the source selection toolbar ──────────────────────────────────
      termSelection: async (_f, _cellId, text) => {
        const args_ = a()
        const active = args_.concepts.filter((c) => c.status === "active")
        return { match: hasSourceTermMatch(text, active, args_.termMatching), canAdd: true, blockedReason: args_.addConceptBlockedReason }
      },
      viewTerm: async (_f, _cellId, text, rect) => {
        setTermRequest({ kind: "view", text, rect, nonce: Date.now() })
        return true
      },
      addTerm: async (_f, _cellId, text, rect) => {
        setTermRequest({ kind: "add", text, rect, nonce: Date.now() })
        return true
      },
      askAi: async (_f, cellId, text) => {
        const args_ = a()
        const cell = view(cellId)
        args_.onAskAi(buildSourceChip({
          chipId: `chip-${cell.fileId}-${cellId}-${Date.now().toString(36)}`,
          fileId: cell.fileId,
          cellId,
          canonicalRef: cell.context ?? cell.group,
          selection: text,
          fileName: args_.fileName,
        }))
        return true
      },
    }
  }, [t, commitAudioValidation])

  const overlay = (
    <ExtensionTermPopovers
      request={termRequest}
      onClose={() => setTermRequest(null)}
      concepts={args.concepts}
      termMatching={args.termMatching}
      onViewConcept={args.onViewConcept}
      onAdd={args.onAddConcept}
      blockedReason={args.addConceptBlockedReason}
      canApprove={args.canApproveConcept}
      cellStore={args.store}
      onSetUpAffixes={args.onSetUpAffixes}
    />
  )
  return { services, versions: { audio: audioByCellId, contextual, smartEdits: smartVersion, examples: args.examples }, overlay }
}

function smartEditId(s: { cellId: string; start: number; end: number; new: string; tier: string }): string {
  return `${s.tier}:${s.start}-${s.end}:${s.new}`.slice(0, 190)
}

const noopSubscribe = () => () => {}
const zero = () => 0
