// The Station: the media view's audio editing panel (AQU-2327). Built from the
// Media Redesign canvas, board 40 ("Station, one design") and board 40b ("the
// working build"), element by element: station-spec/spec.md numbers each one,
// and the numbers in the comments below are those items.
//
// It opens on a TAKE, never on a cell (decided Oct 22), and sits as a tab
// beside Lines and Film (Oct 28). Calm by default: the waveform and Play; a
// selection brings its own actions; the rest appears where and when it is
// needed.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { AudioWaveform, Check, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { castNameOf } from "@/lib/audio/voices"
import { historyView, newestStepMatches, subscribeHistory, undoLast } from "@/lib/history/history"
import { useT } from "@/lib/i18n/I18nProvider"
import { isApplePlatform } from "@/lib/platform"
import { levelsShown, STATION_PICKS } from "@/lib/station/picks"
import { setStationUi } from "@/lib/station/ui"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { decodeToMono48k } from "@/lib/audio/decode-mono"
import { draftKey, readDraft } from "@/lib/station/drafts"
import { mapWindow } from "@/lib/station/edit-list"
import { loadStationPcm, pcmKey, putStationPcm } from "@/lib/station/load"
import { renderSegments } from "@/lib/station/render"
import { saveStationVersion, type VersionPlacement } from "@/lib/station/save"
import {
  clearStationMessage,
  openInStation,
  sameTarget,
  useStationMessage,
  useStationTarget,
  type StationTarget,
} from "@/lib/station/target"
import type { StationHost, StationTake } from "./station-host"
import { changedKinds, StationInsertMenu, StationNotice, type InsertChoice } from "./StationEdits"
import { StationHistory } from "./StationHistory"
import { StationLane } from "./StationLane"
import { StationLevels } from "./StationLevels"
import { StationScroll, StationTransport } from "./StationTransport"
import { STATION_EDIT_MAX_SEC, useStationEditor } from "./useStationEditor"

/** The Station's tab content: the open recording, or how to open one. */
export function StationPanel({ host, visible }: { host: StationHost | null; visible: boolean }) {
  const t = useT()
  const target = useStationTarget()
  const stored = useStationMessage()
  // Q5: leaving a recording with unsaved changes keeps them, and says so.
  const [prev, setPrev] = useState<StationTarget | null>(target)
  const [kept, setKept] = useState<string | null>(null)
  if (!sameTarget(prev, target)) {
    setPrev(target)
    const old = prev && host ? host.readTake(prev.cellId, prev.audioId) : null
    setKept(
      prev && old && readDraft(draftKey(prev))
        ? t("editor.station.keptForLater", {
            name: t("editor.station.nameOnLine", { take: old.att.label ?? t("audio.takesStrip.takeFallback"), line: host!.lineName(prev.cellId) }),
          })
        : null,
    )
  }
  const take = target && host ? host.readTake(target.cellId, target.audioId) : null
  if (!target || !host) return <StationEmpty />
  if (!take) return <StationNote>{<GoneText />}</StationNote>
  return (
    <StationOpen
      key={`${target.fileId}|${target.cellId}|${target.audioId}`}
      host={host}
      take={take}
      target={target}
      visible={visible}
      initialMessage={stored ?? kept}
    />
  )
}

function GoneText() {
  const t = useT()
  return <>{t("editor.station.gone")}</>
}

/** Item 39 (Q1): nothing open — one quiet line says how to open something. */
function StationEmpty() {
  const t = useT()
  return (
    <div data-testid="station-empty" className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground/50">
        <AudioWaveform className="h-5 w-5" />
      </div>
      <p className="max-w-xs text-xs text-muted-foreground">{t("editor.station.empty")}</p>
    </div>
  )
}

function StationNote({ children }: { children: ReactNode }) {
  return (
    <div data-testid="station-note" className="flex h-full min-h-0 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/** Item 3: the message line under the strip. */
export function StationMessage({ text, onClose }: { text: string; onClose(): void }) {
  const t = useT()
  return (
    <div
      role="status"
      data-testid="station-message"
      className="flex shrink-0 items-start gap-2 border-b border-sky-200 bg-sky-50 px-2.5 py-[7px] text-xs leading-[1.4] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
    >
      <span className="min-w-0">{text}</span>
      <button
        type="button"
        onClick={onClose}
        className="ms-auto h-6 shrink-0 px-1 text-xs font-semibold text-sky-700 dark:text-sky-400"
      >
        {t("common.close")}
      </button>
    </div>
  )
}

/** Has this take, or its version chain, been approved enough? (items 5, 6) */
export function approvalState(att: StationTake["att"], needed: number): { approved: boolean; count: number } {
  const count = Math.max(att.validatorCount ?? 0, att.validators?.length ?? 0)
  return { approved: count >= Math.max(1, needed), count }
}

/** How many saves deep this take is: 1 for an original, 2 for its first
 *  saved version (Q2: the take keeps its name, "Version 2" beside it). */
export function versionOf(take: StationTake): number {
  const atts = take.cell.attachments ?? {}
  let n = 1
  let ref = take.att.referenceAudioId
  const seen = new Set<string>()
  while (ref && !seen.has(ref) && atts[ref]) {
    seen.add(ref)
    n += 1
    ref = atts[ref].referenceAudioId
  }
  return n
}

interface OpenProps {
  host: StationHost
  take: StationTake
  target: StationTarget
  visible: boolean
  initialMessage?: string | null
}

function StationOpen({ host, take, target, visible, initialMessage }: OpenProps) {
  const t = useT()
  const [message, setMessage] = useState<string | null>(initialMessage ?? null)
  const ed = useStationEditor(host, take, target, visible)
  const editable = host.editable
  const [hovering, setHovering] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const unsaved = ed.ops.length > 0
  const calm = ed.sel == null && !hovering && !unsaved
  const tooLong = (ed.pcm?.duration ?? 0) > STATION_EDIT_MAX_SEC
  const line = host.lineName(target.cellId)
  const places = host.placementsOf(take.fileId, take.att.url)
  const placeLines = places.length > 1 ? places.map((p) => host.lineName(p.cell.id)) : [line]

  // Item 2 / slice 9: the ⋯ menu's Remove noise and Change the voice, each
  // making a new version (the original is kept).
  const versionNext = versionOf(take) + 1
  useEffect(() => {
    if (!editable) return
    setStationUi({
      removeNoise: () => {
        setMessage(t("editor.station.noiseRunning"))
        void host
          .removeNoise(target.cellId, target.audioId)
          .then((id) => {
            if (id) openInStation({ ...target, audioId: id }, { message: t("editor.station.noiseDone", { n: versionNext, line }) })
          })
          .catch((e: unknown) => setMessage(t("editor.station.saveFailed", { message: e instanceof Error ? e.message : String(e) })))
      },
      changeVoice: () => setMessage(host.changeVoice(target.cellId) ?? t("editor.station.voiceStarted")),
    })
    return () => setStationUi({ removeNoise: null, changeVoice: null })
  }, [editable, host, target, line, versionNext, t])

  const approve = () => {
    const v = host.voteState(target.cellId, target.audioId)
    if (v.canVote && !v.voted) void host.vote(target.cellId, target.audioId, true)
  }

  // Item 18: the audio to insert — another recording, a file, or one made now.
  // Each arrives later, so it goes into the edit list as it stands THEN.
  const edRef = useRef(ed)
  useEffect(() => {
    edRef.current = ed
  })
  const insertChoice = (c: InsertChoice) => {
    setInsertOpen(false)
    void loadStationPcm({ url: c.url, projectId: host.project.id, fileId: c.fileId, getSyncToken: host.getSyncToken })
      .then((pcm) => edRef.current.insertAudio(pcmKey(c.url), pcm, { kind: "take", url: c.url, fileId: c.fileId, label: c.label }))
      .catch(() => setMessage(t("editor.station.loadFailed")))
  }
  const insertFile = (file: File) => {
    setInsertOpen(false)
    const name = file.name.replace(/\.[^.]+$/, "")
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin").toLowerCase()
    const cacheId = `station-insert-${Date.now().toString(36)}`
    void file
      .arrayBuffer()
      .then((ab) => decodeToMono48k(new Uint8Array(ab)))
      .then((data) => {
        void audioCachePutBlob(cacheId, ext, file)
        const pcm = putStationPcm(cacheId, data)
        edRef.current.insertAudio(cacheId, pcm, { kind: "file", cacheId, ext, label: t("editor.station.fileLabel", { name }) })
      })
      .catch(() => setMessage(t("editor.station.notAudio", { name: file.name })))
  }
  // Slice 10: Record now — the recorder opens on this line and hands its
  // recording back; it goes in at the cursor.
  const insertRecording = () => {
    setInsertOpen(false)
    void host.recordInsert(target.cellId).then(async (r) => {
      if (!r) return
      const cacheId = `station-rec-${Date.now().toString(36)}`
      try {
        const data = await decodeToMono48k(new Uint8Array(await r.blob.arrayBuffer()))
        void audioCachePutBlob(cacheId, r.ext, r.blob)
        edRef.current.insertAudio(cacheId, putStationPcm(cacheId, data), { kind: "recording", cacheId, ext: r.ext, label: t("editor.station.recordedInsert") })
      } catch {
        setMessage(t("editor.station.loadFailed"))
      }
    })
  }

  // Item 35: render the edited recording and save it as a new version, on
  // this line only or everywhere it is placed (slice 6).
  const save = async () => {
    if (!ed.pcm || !unsaved || saving) return
    setSaving(true)
    ed.pause()
    try {
      const samples = renderSegments(ed.placed, ed.lookup, ed.pcm.rate)
      const L = samples.length / ed.pcm.rate
      const everywhere = ed.draft.scope === "all" && places.length > 1
      const targets = everywhere ? places.map((p) => (p.cell.id === target.cellId ? take : p)) : [take]
      // Q6: a piece of a split take is replaced in place, as a piece.
      const atts = take.cell.attachments ?? {}
      const isPiece = Boolean(take.att.pieceOf) || Object.values(atts).some((a) => !a.isDeleted && a.pieceOf === target.audioId)
      const pieceRoot = take.att.pieceOf ?? target.audioId
      const placements: VersionPlacement[] = targets.map((p) => {
        const isOpen = p.cell.id === target.cellId
        // The open clip keeps the kept part as edited; another placement keeps
        // exactly the sound it had (its own window, carried through the edits).
        const w = isOpen
          ? { start: ed.trimA, end: ed.trimB }
          : mapWindow(
              { start: (p.att.trimStartMs ?? 0) / 1000, end: p.att.trimEndMs != null ? p.att.trimEndMs / 1000 : ed.pcm!.duration },
              ed.ops,
            )
        const slot = p.att.slot ?? "recording"
        const fromAudioId = Object.entries(p.cell.attachments ?? {}).find(([, a]) => a === p.att)?.[0] ?? target.audioId
        return {
          fileId: p.fileId,
          cellId: p.cell.id,
          fromAudioId: isOpen ? target.audioId : fromAudioId,
          slot,
          label: p.att.label ?? null,
          trimStartMs: w.start > 0.0005 ? Math.round(w.start * 1000) : null,
          trimEndMs: w.end < L - 0.0005 ? Math.round(w.end * 1000) : null,
          targetOffsetMs: p.att.targetOffsetMs ?? null,
          recordingsOffsetMs: p.att.recordingsOffsetMs ?? null,
          selectedBefore: host.selectedIn(p.cell.id, slot),
          // Its volume and fades go with it: the clip's, not the recording's.
          level: isOpen
            ? { gainDb: ed.level.gainDb || null, fadeInMs: ed.level.fadeIn > 0 ? Math.round(ed.level.fadeIn * 1000) : null, fadeOutMs: ed.level.fadeOut > 0 ? Math.round(ed.level.fadeOut * 1000) : null }
            : { gainDb: p.att.gainDb ?? null, fadeInMs: p.att.fadeInMs ?? null, fadeOutMs: p.att.fadeOutMs ?? null },
          ...(isOpen && isPiece ? { pieceOf: pieceRoot } : {}),
        }
      })
      const res = await saveStationVersion({
        projectId: host.project.id,
        samples,
        rate: ed.pcm.rate,
        placements,
        author: host.username,
        ...(host.lane ? { targetLang: host.lane } : {}),
        getSyncToken: host.getSyncToken,
        where: { fileId: take.fileId, fileName: host.fileName(take.fileId) },
      })
      const n = versionOf(take) + 1
      ed.clearDraft()
      const text = everywhere
        ? t("editor.station.savedEverywhere", { n, lines: placeLines.join(", ") })
        : t("editor.station.saved", { n, line })
      const openIdx = targets.findIndex((p) => p.cell.id === target.cellId)
      openInStation({ fileId: take.fileId, cellId: target.cellId, audioId: res.audioIds[Math.max(0, openIdx)] }, { message: text })
    } catch (e) {
      setMessage(t("editor.station.saveFailed", { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }

  // Item 33: the keys, while the Station has the focus. A text field keeps
  // its own. ⌘Z takes back an unsaved edit first; otherwise it is the
  // project's own Undo (Q4), which the window's shortcut runs.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
    const k = e.key
    const mod = e.metaKey || e.ctrlKey
    let handled = true
    if (mod && !e.shiftKey && (k === "z" || k === "Z")) handled = ed.undoUnsaved()
    else if (mod && (k === "s" || k === "S")) void save()
    else if (mod || e.altKey) handled = false
    else if (k === " ") ed.togglePlay()
    else if (k === "k" || k === "K") void ed.keepSelection()
    else if ((k === "Backspace" || k === "Delete") && editable && !tooLong) ed.deleteSelection()
    else if ((k === "i" || k === "I") && editable && !tooLong && ed.sel) setInsertOpen(true)
    else if (k === "a" || k === "A") approve()
    else if (k === "=" || k === "+") ed.zoomBy(2)
    else if (k === "-") ed.zoomBy(0.5)
    else if (k === "l" || k === "L") ed.toggleLoop()
    else if (k === "Escape") {
      ed.clearSel()
      setInsertOpen(false)
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div
      data-testid="station"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col overflow-y-auto outline-none"
    >
      {message ? (
        <StationMessage
          text={message}
          onClose={() => {
            setMessage(null)
            clearStationMessage()
          }}
        />
      ) : null}
      <StationHeader host={host} take={take} target={target} places={placeLines} unsaved={unsaved} undoUnsaved={ed.undoUnsaved} />
      {unsaved ? (
        <StationNotice
          kinds={changedKinds(ed.ops)}
          places={placeLines}
          scope={ed.draft.scope}
          onScope={ed.setScope}
          openLine={line}
          saving={saving}
          onSave={() => void save()}
        />
      ) : null}
      {ed.status === "error" ? (
        <StationNote>{t("editor.station.loadFailed")}</StationNote>
      ) : (
        <>
          <StationLane
            ed={ed}
            editable={editable}
            trackVars={host.trackVars(take.fileId, take.att.slot)}
            generated={Boolean(take.att.voiceId)}
            onHover={setHovering}
            {...(editable && levelsShown() ? { hoverLayer: (h: boolean, lane: HTMLElement | null) => <StationLevels ed={ed} lane={lane} hover={h} /> } : {})}
            {...(editable && tooLong ? { editNote: t("editor.station.tooLong") } : {})}
            {...(editable && !tooLong
              ? {
                  onDelete: ed.deleteSelection,
                  onInsert: () => setInsertOpen((o) => !o),
                  insertOpen: insertOpen && ed.sel != null,
                  insertMenu: (
                    <StationInsertMenu
                      choices={host.insertChoices(take.fileId, target.cellId, take.att.url)}
                      onPick={insertChoice}
                      onFile={insertFile}
                      onRecord={insertRecording}
                    />
                  ),
                }
              : {})}
          />
          <StationScroll ed={ed} />
          <StationTransport
            ed={ed}
            editable={editable}
            calm={calm}
            hint={editable ? t("editor.station.hint") : t("editor.station.hintCalm")}
            onMessage={setMessage}
          />
          <StationHistory
            host={host}
            take={take}
            cellId={target.cellId}
            audioId={target.audioId}
            ops={ed.ops}
            durationSec={ed.pcm?.duration ?? null}
            refreshKey={`${take.att.trimStartMs}|${take.att.trimEndMs}|${take.att.validatorCount}|${take.att.label}`}
          />
        </>
      )}
    </div>
  )
}

/** Items 4–7: the recording's name, where it is placed, its status and
 *  version; Undo and Approve. */
export function StationHeader({
  host,
  take,
  target,
  places,
  unsaved = false,
  undoUnsaved,
}: {
  host: StationHost
  take: StationTake
  target: StationTarget
  /** The lines it is placed on (slice 6); the open one when only one. */
  places?: readonly string[]
  /** Unsaved sound edits: it waits again (40b), and Undo takes them back first. */
  unsaved?: boolean
  undoUnsaved?(): boolean
}) {
  const t = useT()
  const { cellId, audioId } = target
  const line = host.lineName(cellId)
  const name = take.att.label ?? t("audio.takesStrip.takeFallback")
  const character = castNameOf(take.cell)
  const vars = host.trackVars(take.fileId, take.att.slot)
  const counted = approvalState(take.att, host.approvalsNeeded)
  const approved = counted.approved && !unsaved
  const count = unsaved ? 0 : counted.count
  const lines = places && places.length > 0 ? places : [line]
  const placedText =
    lines.length > 2
      ? t("editor.station.placedOnMany", { count: lines.length, open: line })
      : lines.length === 2
        ? t("editor.station.placedOnTwo", { a: lines[0], b: lines[1], open: line })
        : t("editor.station.placedOn", { line })
  const version = versionOf(take)
  const vote = host.voteState(cellId, audioId)
  const statusText = approved
    ? `✓ ${t("editor.station.approved")}`
    : STATION_PICKS.showApprovalCount && host.approvalsNeeded > 1 && count > 0
      ? `◷ ${t("editor.station.waitingCount", { done: count, need: host.approvalsNeeded })}`
      : `◷ ${t("editor.station.waiting")}`

  // Q4: the Station's own Undo takes back your last change to THIS recording;
  // greyed, with the reason, when your newest change was somewhere else.
  const view = useSyncExternalStore(subscribeHistory, historyView, historyView)
  const mine = useCallback(
    (_kind: string, data: unknown) => {
      const d = data as { cellId?: string; audioId?: string } | null
      return d?.cellId === cellId && (d.audioId === undefined || d.audioId === audioId)
    },
    [cellId, audioId],
  )
  const canUndo = unsaved || (view.canUndo && (STATION_PICKS.undoButton === "project" || newestStepMatches(mine)))
  const undoTip = unsaved
    ? t("editor.station.undoUnsaved")
    : canUndo
      ? t("editor.station.undoTip", { keys: isApplePlatform() ? "⌘Z" : "Ctrl+Z" })
      : view.canUndo
        ? t("editor.station.undoElsewhere")
        : t("editor.station.nothingToUndo")
  const undo = () => {
    if (unsaved && undoUnsaved?.()) return
    if (!canUndo) return
    void undoLast().then((r) => {
      if (r) host.reportHistory("undo", r)
    })
  }

  return (
    <div data-testid="station-header" className="flex shrink-0 items-center gap-2 pt-2 pb-1.5 ps-3 pe-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-semibold whitespace-nowrap text-foreground">
          {t("editor.station.nameOnLine", { take: name, line })}
        </span>
        <span data-testid="station-subline" className="truncate text-[11px] text-muted-foreground">
          {character ? (
            <>
              <span className="font-bold" style={{ color: vars["--tl-track-hue"] }}>
                {character}
              </span>
              {" · "}
            </>
          ) : null}
          {placedText}
          {" · "}
          <span
            data-testid="station-status"
            className={approved ? "font-semibold text-green-700 dark:text-green-400" : "font-semibold text-sky-700 dark:text-sky-400"}
          >
            {statusText}
          </span>
          {version > 1 ? ` · ${t("editor.station.version", { n: version })}` : null}
        </span>
      </span>
      <span className="ms-auto inline-flex shrink-0 items-center gap-1">
        <AppTooltip content={undoTip}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            data-testid="station-undo"
            aria-label={undoTip}
            aria-disabled={!canUndo}
            onClick={undo}
            className={canUndo ? "text-foreground" : "text-muted-foreground/40 hover:bg-background"}
          >
            <Undo2 className="size-3.5" />
          </Button>
        </AppTooltip>
        {vote.canVote && !vote.voted && !approved ? (
          <AppTooltip content={t("editor.station.approveTip", { line })}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="station-approve"
              onClick={() => void host.vote(cellId, audioId, true)}
              className="text-[12.5px] font-medium"
            >
              <Check className="size-[13px]" />
              {t("editor.station.approve")}
            </Button>
          </AppTooltip>
        ) : null}
      </span>
    </div>
  )
}
