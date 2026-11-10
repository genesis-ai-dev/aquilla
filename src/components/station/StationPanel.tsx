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
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { AppTooltip } from "@/components/ui/tooltip"
import { castNameOf } from "@/lib/audio/voices"
import { historyView, newestMatchingStep, subscribeHistory, undoLast, undoStepById } from "@/lib/history/history"
import { useT } from "@/lib/i18n/I18nProvider"
import { audioIdSeededWith } from "@/lib/audio/upload"
import { isGeneratedTake } from "@/lib/audio/track-audio"
import { levelsShown, STATION_PICKS } from "@/lib/station/picks"
import { setStationUi } from "@/lib/station/ui"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { decodeToMono48k } from "@/lib/audio/decode-mono"
import { draftKey, readDraft } from "@/lib/station/drafts"
import { mapWindow, type EditOp } from "@/lib/station/edit-list"
import type { VersionChanges } from "@/lib/sync/outbox-types"
import { loadStationPcm, pcmKey, putStationPcm } from "@/lib/station/load"
import { renderSegments } from "@/lib/station/render"
import { formatStationTime } from "@/lib/station/time"
import { spacebarShouldToggle } from "@/lib/audio/playback-keys"
import { isApplePlatform } from "@/lib/platform"
import { versionOfId } from "@/lib/station/version"
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
import { changedKinds, StationInsertMenu, StationSave, useChangedText, type InsertChoice, type SaveHow } from "./StationEdits"
import { StationHistory } from "./StationHistory"
import { StationLane } from "./StationLane"
import { StationLevels } from "./StationLevels"
import { StationRecordBar, useStationRecorder } from "./StationRecorder"
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
  // Undo of a Save takes the saved take away and brings back the one it was
  // made from: the Station opens that one again rather than saying the
  // recording is gone (found in the Nov 2 browser check).
  const madeFrom = take?.att.referenceAudioId ?? null
  const [origin, setOrigin] = useState<{ audioId: string; from: string } | null>(null)
  if (target && madeFrom && (origin?.audioId !== target.audioId || origin.from !== madeFrom)) {
    setOrigin({ audioId: target.audioId, from: madeFrom })
  }
  const backTo = !take && target && host && origin?.audioId === target.audioId && host.readTake(target.cellId, origin.from) ? origin.from : null
  useEffect(() => {
    if (backTo && target) openInStation({ ...target, audioId: backTo })
  }, [backTo, target])
  if (!target || !host) return <StationEmpty />
  if (!take) return backTo ? null : <StationNote>{<GoneText />}</StationNote>
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

/** The kinds of change a version holds, each once, in the order they happened. */
export function versionKinds(ops: readonly EditOp[]): VersionChanges["kinds"] {
  return changedKinds(ops).filter((k): k is "deleted" | "inserted" => k === "deleted" || k === "inserted")
}

/** Which version this take is: 1 for an original, 2 for its first saved
 *  version (Q2: the take keeps its name, "Version 2" beside it). A take saved
 *  over isn't counted (lib/station/version.ts). */
export function versionOf(take: StationTake): number {
  return versionOfId(take.cell.attachments ?? {}, take.att.referenceAudioId)
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
  // Q10 (Sam, Oct 30): the imported source recording is everyone's timing
  // reference — it opens to listen, select and loop, its tools hidden, with a
  // plain line saying why. One switch: STATION_PICKS.sourceEditable.
  const isSource = take.att.role === "source" || audioIdSeededWith(target.audioId, take.fileId)
  const editable = host.editable && (!isSource || STATION_PICKS.sourceEditable)
  const [hovering, setHovering] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMenu, setSaveMenu] = useState(false)
  const changedText = useChangedText()
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
  // Slice 14 (Sam, Nov 2): Record now records here, at the cursor, with no
  // recording window (StationRecorder.tsx).
  const rec = useStationRecorder(ed, setMessage)
  const recording = rec.phase.kind === "counting" || rec.phase.kind === "recording" || rec.phase.kind === "finishing"
  const insertRecording = () => {
    setInsertOpen(false)
    if (ed.sel) rec.start(ed.sel.a)
  }
  const recPart =
    rec.phase.kind === "idle"
      ? undefined
      : {
          at: rec.phase.at,
          t1:
            rec.phase.kind === "pending"
              ? rec.phase.at + rec.phase.len
              : ed.live
                ? rec.phase.at + ed.live.src.data.length / ed.live.src.rate
                : null,
          flag:
            rec.phase.kind === "counting"
              ? rec.count != null
                ? t("editor.station.recordFlagIn", { n: rec.count })
                : t("editor.station.recordFlagReady")
              : rec.phase.kind === "pending"
                ? t("editor.station.newRecording")
                : t("editor.station.recordFlag", { time: formatStationTime(rec.phase.at) }),
        }

  // Item 35: render the edited recording and save it — over the take on
  // every line it is used on (Sam, Nov 2), or as a new version on this line
  // only or everywhere it is placed (slice 6).
  const save = async (how: SaveHow) => {
    if (!ed.pcm || !unsaved || saving) return
    setSaving(true)
    setSaveMenu(false)
    ed.pause()
    try {
      const samples = renderSegments(ed.placed, ed.lookup, ed.pcm.rate)
      const L = samples.length / ed.pcm.rate
      const everywhere = how.scope === "all" && places.length > 1
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
          // AQU-2492 (review, Nov 9), finding 8: who had approved the take it replaces.
          approvedBy: p.att.validators ?? [],
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
        // Item 30: what changed and where it went, for its History row.
        changes: { kinds: versionKinds(ed.ops), usedOn: targets.map((p) => p.cell.id) },
        mode: how.mode,
      })
      const n = versionOf(take) + 1
      ed.clearDraft()
      const text =
        how.mode === "over"
          ? t("editor.station.savedOver", {
              take: take.att.label ?? t("audio.takesStrip.takeFallback"),
              lines: everywhere ? placeLines.join(", ") : line,
            })
          : everywhere
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

  // A button pressed in the Station that goes away when pressed (Insert ›
  // Record now, Keep, Record again, Delete this, the message's Close), or is
  // disabled for a moment (Stop, while the recording finishes), took the
  // focus with it, so Space, Esc, Enter and ⌘S stopped reaching the Station
  // (found in the Nov 2 browser check). When the focus was last in the
  // Station and has fallen to nothing, without a press somewhere else on the
  // page, the Station takes it back.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) lastFocused.current = null
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [])
  useEffect(() => {
    const was = lastFocused.current
    const now = document.activeElement
    if (was && was !== now && (now == null || now === document.body)) rootRef.current?.focus({ preventScroll: true })
  })

  // Item 33: the keys, while the Station has the focus. A text field keeps
  // its own. ⌘Z takes back an unsaved edit first; otherwise it is the
  // project's own Undo (Q4), which the window's shortcut runs.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
    // The Station's own menus (Save's, the speed's) are drawn elsewhere on
    // the page but still pass their keys up here: they keep them, so Esc
    // closes the menu and a letter never runs a Station command (Nov 2
    // shortcut review).
    if (el?.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return
    const k = e.key
    // A letter as typed, or the key's place when the layout types no Latin
    // letter (Russian, Arabic, Thai…), so K, I, A, L, ⌘Z and ⌘S still work.
    const letter = /^[a-z]$/i.test(k) ? k.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ""
    // Slice 14: while recording, Space and Esc stop it and other keys wait.
    // After, Enter keeps it; Esc never throws it away (the recording window
    // asks before it does): Record again or Undo takes it out.
    if (recording || (rec.phase.kind === "pending" && k === "Enter")) {
      if (recording) {
        if (k === " " || k === "Escape") rec.stop()
      } else rec.keep()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    let handled = true
    // Never with Alt: AltGr on a Windows layout arrives as Ctrl+Alt, and
    // AltGr+S types ś in Polish (Nov 2 shortcut review).
    if (mod && !e.altKey && !e.shiftKey && letter === "z") handled = ed.undoUnsaved()
    // ⌘S is Save: over the take, wherever it is used (Sam, Nov 2).
    else if (mod && !e.altKey && letter === "s") void save({ mode: "over", scope: "all" })
    // The timeline's ⌘Enter (back to the start) would rewind it from here.
    else if (mod && k === "Enter") handled = true
    else if (mod || e.altKey) handled = false
    // Space presses a focused button rather than playing (playback-keys.ts).
    else if (k === " ") {
      if (spacebarShouldToggle(e.nativeEvent)) ed.togglePlay()
      else handled = false
    } else if (letter === "k") void ed.keepSelection()
    else if ((k === "Backspace" || k === "Delete") && editable && !tooLong) ed.deleteSelection()
    else if (letter === "i" && editable && !tooLong && ed.sel) setInsertOpen(true)
    else if (letter === "a") approve()
    else if (k === "=" || k === "+") ed.zoomBy(2)
    else if (k === "-") ed.zoomBy(0.5)
    else if (letter === "l") ed.toggleLoop()
    // The timeline's S (split) and B (blade) listen on the whole window: from
    // the Station they would cut the take open here, unseen. They stop here.
    else if (letter === "s" || letter === "b") handled = true
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
      ref={rootRef}
      data-testid="station"
      tabIndex={0}
      onFocus={(e) => {
        lastFocused.current = e.target as HTMLElement
      }}
      // Item 33: Esc here clears the selection and closes Insert; while there
      // is one of those, full screen's own Esc stands down (useMediaDock).
      data-owns-escape={ed.sel != null || insertOpen || rec.busy ? "true" : undefined}
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
      <StationHeader
        host={host}
        take={take}
        target={target}
        places={placeLines}
        unsaved={unsaved}
        undoUnsaved={ed.undoUnsaved}
        isSource={isSource}
        controlsInfo={editable}
        {...(unsaved
          ? {
              notSaved: changedText(changedKinds(ed.ops)),
              save: (
                <StationSave
                  places={placeLines}
                  openLine={line}
                  saving={saving}
                  onSave={(how) => void save(how)}
                  menuOpen={saveMenu}
                  onMenuOpen={setSaveMenu}
                />
              ),
            }
          : {})}
      />
      {isSource && !STATION_PICKS.sourceEditable ? (
        <p data-testid="station-source-note" className="shrink-0 px-3 pb-1 text-[11.5px] text-muted-foreground">
          {t("editor.station.sourceReadOnly")}
        </p>
      ) : null}
      {ed.status === "error" ? (
        <StationNote>{t("editor.station.loadFailed")}</StationNote>
      ) : (
        <>
          <StationLane
            ed={ed}
            editable={editable && !rec.busy}
            {...(recPart ? { recording: recPart } : {})}
            trackVars={host.trackVars(take.fileId, take.att.slot)}
            // AQU-2235 (merged in): the one rule every surface asks before it
            // draws an AI voice's sparkle, so the Station agrees with the timeline
            // and the takes lists about which takes wear it.
            generated={isGeneratedTake(take.cell, target.audioId, take.att)}
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
            editable={editable && !recording}
            locked={recording}
            {...(rec.busy ? { status: <StationRecordBar rec={rec} /> } : {})}
            calm={calm}
            hint={editable ? t("editor.station.hint", { mod: modKey() }) : t("editor.station.hintListen")}
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
 *  version; Undo, Save (item 8, while a change isn't saved) and Approve. */
export function StationHeader({
  host,
  take,
  target,
  places,
  unsaved = false,
  undoUnsaved,
  isSource = false,
  notSaved,
  save,
  controlsInfo = false,
}: {
  host: StationHost
  take: StationTake
  target: StationTarget
  /** The lines it is placed on (slice 6); the open one when only one. */
  places?: readonly string[]
  /** Unsaved sound edits: it waits again (40b), and Undo takes them back first. */
  unsaved?: boolean
  undoUnsaved?(): boolean
  /** Q10: the imported source recording — named as the source, with no
   *  approval status (it is never approved) and no "placed on". */
  isSource?: boolean
  /** Item 8: what isn't saved yet ("a part deleted, audio inserted"). */
  notSaved?: string
  /** Item 8: the Save button, between Undo and Approve. */
  save?: ReactNode
  /** The (i) beside the name that explains the controls (Sam, Nov 2). */
  controlsInfo?: boolean
}) {
  const t = useT()
  const [infoOpen, toggleInfo] = useInfoOpen()
  const { cellId, audioId } = target
  const line = host.lineName(cellId)
  const name = isSource ? t("editor.station.sourceName") : (take.att.label ?? t("audio.takesStrip.takeFallback"))
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

  // Q4 (Sam, Oct 30): the Station's own Undo always takes back your last
  // change to THIS recording, even if you have changed other things since;
  // ⌘Z stays the project's newest step. Unsaved edits go first.
  const view = useSyncExternalStore(subscribeHistory, historyView, historyView)
  const mine = useCallback(
    (_kind: string, data: unknown) => {
      const d = data as { cellId?: string; audioId?: string } | null
      return d?.cellId === cellId && (d.audioId === undefined || d.audioId === audioId)
    },
    [cellId, audioId],
  )
  const step = STATION_PICKS.undoButton === "project" ? (view.nextUndo ?? null) : view.canUndo ? newestMatchingStep(mine) : null
  const canUndo = unsaved || step != null
  const undoTip = unsaved
    ? t("editor.station.undoUnsaved")
    : step
      ? t("editor.station.undoTip")
      : t("editor.station.nothingToUndo")
  const undo = () => {
    if (unsaved && undoUnsaved?.()) return
    if (!step) return
    void (STATION_PICKS.undoButton === "project" ? undoLast() : undoStepById(step.id)).then((r) => {
      if (r) host.reportHistory("undo", r)
    })
  }

  return (
    <div data-testid="station-header" className="shrink-0 pt-2 pb-1.5 ps-3 pe-2">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold whitespace-nowrap text-foreground">
            {t("editor.station.nameOnLine", { take: name, line })}
            {controlsInfo ? (
              <InfoToggle open={infoOpen} onToggle={toggleInfo} label={t("editor.station.controlsInfo")} controls="station-controls-info" testId="station-info" />
            ) : null}
          </span>
          {isSource && !character ? null : (
            <span data-testid="station-subline" className="truncate text-[11px] text-muted-foreground">
              {character ? (
                <>
                  <span className="font-bold" style={{ color: vars["--tl-track-hue"] }}>
                    {character}
                  </span>
                  {isSource ? null : " · "}
                </>
              ) : null}
              {isSource ? null : (
                <>
                  {placedText}
                  {" · "}
                  <span
                    data-testid="station-status"
                    className={approved ? "font-semibold text-green-700 dark:text-green-400" : "font-semibold text-sky-700 dark:text-sky-400"}
                  >
                    {statusText}
                  </span>
                  {version > 1 ? ` · ${t("editor.station.version", { n: version })}` : null}
                  {notSaved ? (
                    <>
                      {" · "}
                      <span data-testid="station-not-saved" className="font-semibold text-amber-700 dark:text-amber-400">
                        {t("editor.station.notSaved", { what: notSaved })}
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </span>
          )}
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
          {save}
          {vote.canVote && !vote.voted && !approved && !isSource ? (
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
      {controlsInfo ? (
        <InfoReveal open={infoOpen} id="station-controls-info" testId="station-controls-info">
          <StationControlsHelp />
        </InfoReveal>
      ) : null}
    </div>
  )
}

/** ⌘ on a Mac, Ctrl+ elsewhere, before a letter in the Station's key lists. */
const modKey = () => (isApplePlatform() ? "⌘" : "Ctrl+")

/** What the (i) opens: each control in one plain line, then the keys. */
function StationControlsHelp() {
  const t = useT()
  // Full keys, so the word check finds every one.
  const rows = [
    [t("editor.station.helpSelectTerm"), t("editor.station.helpSelect")],
    [t("editor.station.helpTrimTerm"), t("editor.station.helpTrim")],
    [t("editor.station.helpEditTerm"), t("editor.station.helpEdit")],
    [t("editor.station.helpVolumeTerm"), t("editor.station.helpVolume")],
    [t("editor.station.helpFadesTerm"), t("editor.station.helpFades")],
    [t("editor.station.helpSaveTerm"), t("editor.station.helpSave")],
    [t("editor.station.helpKeysTerm"), t("editor.station.helpKeys", { mod: modKey() })],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1.5 pb-0.5 text-[11.5px] leading-[1.45]">
      {rows.map(([term, text]) => (
        <div key={term} className="contents">
          <dt className="font-semibold text-foreground">{term}</dt>
          <dd className="m-0 text-muted-foreground">{text}</dd>
        </div>
      ))}
    </dl>
  )
}
