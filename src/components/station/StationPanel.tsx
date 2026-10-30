// The Station: the media view's audio editing panel (AQU-2327). Built from the
// Media Redesign canvas, board 40 ("Station, one design") and board 40b ("the
// working build"), element by element: station-spec/spec.md numbers each one,
// and the numbers in the comments below are those items.
//
// It opens on a TAKE, never on a cell (decided Oct 22), and sits as a tab
// beside Lines and Film (Oct 28). Calm by default: the waveform and Play; a
// selection brings its own actions; the rest appears where and when it is
// needed.

import { useCallback, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { AudioWaveform, Check, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { castNameOf } from "@/lib/audio/voices"
import { historyView, newestStepMatches, subscribeHistory, undoLast } from "@/lib/history/history"
import { useT } from "@/lib/i18n/I18nProvider"
import { isApplePlatform } from "@/lib/platform"
import { STATION_PICKS } from "@/lib/station/picks"
import { useStationTarget, type StationTarget } from "@/lib/station/target"
import type { StationHost, StationTake } from "./station-host"
import { StationHistory } from "./StationHistory"
import { StationLane } from "./StationLane"
import { StationScroll, StationTransport } from "./StationTransport"
import { useStationEditor } from "./useStationEditor"

/** The Station's tab content: the open recording, or how to open one. */
export function StationPanel({ host, visible }: { host: StationHost | null; visible: boolean }) {
  const target = useStationTarget()
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
}

function StationOpen({ host, take, target, visible }: OpenProps) {
  const t = useT()
  const [message, setMessage] = useState<string | null>(null)
  const ed = useStationEditor(host, take, target, visible)
  const editable = host.editable
  const [hovering, setHovering] = useState(false)
  const unsaved = ed.ops.length > 0
  const calm = ed.sel == null && !hovering && !unsaved

  const approve = () => {
    const v = host.voteState(target.cellId, target.audioId)
    if (v.canVote && !v.voted) void host.vote(target.cellId, target.audioId, true)
  }

  // Item 33: the keys, while the Station has the focus. A text field keeps
  // its own; ⌘Z stays the project's (Q4) unless the Station has unsaved
  // edits of its own to take back first (slice 5).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    let handled = true
    if (k === " ") ed.togglePlay()
    else if (k === "k" || k === "K") void ed.keepSelection()
    else if (k === "a" || k === "A") approve()
    else if (k === "=" || k === "+") ed.zoomBy(2)
    else if (k === "-") ed.zoomBy(0.5)
    else if (k === "l" || k === "L") ed.toggleLoop()
    else if (k === "Escape") ed.clearSel()
    else handled = false
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
      {message ? <StationMessage text={message} onClose={() => setMessage(null)} /> : null}
      <StationHeader host={host} take={take} target={target} onMessage={setMessage} />
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
          />
          <StationScroll ed={ed} />
          <StationTransport ed={ed} editable={editable} calm={calm} hint={t("editor.station.hintCalm")} onMessage={setMessage} />
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
}: {
  host: StationHost
  take: StationTake
  target: StationTarget
  onMessage?(text: string): void
}) {
  const t = useT()
  const { cellId, audioId } = target
  const line = host.lineName(cellId)
  const name = take.att.label ?? t("audio.takesStrip.takeFallback")
  const character = castNameOf(take.cell)
  const vars = host.trackVars(take.fileId, take.att.slot)
  const { approved, count } = approvalState(take.att, host.approvalsNeeded)
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
  const canUndo = view.canUndo && (STATION_PICKS.undoButton === "project" || newestStepMatches(mine))
  const undoTip = canUndo
    ? t("editor.station.undoTip", { keys: isApplePlatform() ? "⌘Z" : "Ctrl+Z" })
    : view.canUndo
      ? t("editor.station.undoElsewhere")
      : t("editor.station.nothingToUndo")
  const undo = () => {
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
          {t("editor.station.placedOn", { line })}
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
