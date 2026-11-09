// AQU-2401: Play for the line's own recording, in the left validation gutter
// immediately after the audio check.
//
// WHY IT MOVED OUT OF THE `⋯`. AQU-200 collapsed the rail into a primary group
// plus an overflow and put Play inside it, leaving an emerald dot on the
// trigger to stand for the hidden button. Its own rule is that an action
// frequent enough to earn a direct slot is promoted back out — AQU-2287 did
// that for Record. The audio validation workflow (AQU-490) is listen →
// validate, line after line, and the listen half cost two clicks on every
// line while the check it answers sat in the gutter. Play belongs beside it,
// so the whole loop stays in one strip (AQU-592's reasoning for the check).
//
// It draws wherever the audio check draws and nowhere else: the audio column
// itself only exists on a file that has audio (AQU-1495), so a text-only file
// gets neither, and its rail is unchanged.
//
// This is chrome only. Playback, the window a take plays through, and which
// clip is the line's are all the caller's (`useCellAudio` in the row), so
// moving the button changed none of them.

import { Pause, Play } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { NoteOnClick } from "@/components/ui/info-note"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"

export interface CellAudioPlayControlProps {
  /** The line's reference, for the faded slot's accessible name. */
  cellRef: string
  /** Still reading the file's recordings: reserve the slot, draw nothing. */
  checking: boolean
  /** Is there a clip for this line to play. */
  hasTake: boolean
  /** That clip is sounding right now. */
  playing: boolean
  /** It has not finished loading, so a press would do nothing. */
  loading: boolean
  onToggle: () => void
}

export function CellAudioPlayControl({
  cellRef, checking, hasTake, playing, loading, onToggle,
}: CellAudioPlayControlProps) {
  const { t } = useI18n()

  // Reserved, empty. The same rule the check beside it follows (Sam,
  // 2026-10-01): until the recordings are read, an absent take is not "no
  // recording", so the slot holds its width and offers nothing to press —
  // the row must not shuffle under the pointer a moment later, and the
  // target text's left edge must not move between rows.
  if (checking) {
    return (
      <div
        data-testid="cell-audio-play-gutter"
        aria-hidden
        className="flex w-6 shrink-0 flex-col items-center pt-1"
      >
        <span className="block h-6 w-6" />
      </div>
    )
  }

  // Nothing to play: a FADED ▶ beside the faded circle, matching the check's
  // own rule for an empty line (Sam, 2026-09-23). A span inside NoteOnClick,
  // not a disabled button — no tab stop on a mark repeated down every row,
  // and a click still says why there is nothing to hear.
  if (!hasTake) {
    return (
      <div data-testid="cell-audio-play-gutter" className="flex w-6 shrink-0 flex-col items-center pt-1">
        <NoteOnClick
          note={t("editor.audio.noRecordingNote")}
          side="right"
          align="start"
          tabStop={false}
        >
          <span
            role="img"
            data-testid="cell-audio-play-unavailable"
            aria-label={t("editor.audio.ariaNoRecording", { ref: cellRef })}
            className="flex h-6 w-6 items-center justify-center text-muted-foreground/30 opacity-40"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </NoteOnClick>
      </div>
    )
  }

  return (
    <div data-testid="cell-audio-play-gutter" className="flex w-6 shrink-0 flex-col items-center pt-1">
      {/* AQU-755: AppTooltip, not a native `title`, so the name surfaces on
          keyboard focus as well as hover — and AQU-2260 allows a hover to NAME
          an icon-only button, which is all this is. */}
      <AppTooltip content={playing ? t("common.pause") : t("editor.audio.play")}>
        <button
          type="button"
          data-testid="cell-audio-play-button"
          data-tooltip={playing ? t("common.pause") : t("editor.audio.play")}
          aria-label={playing ? t("common.pause") : t("editor.audio.play")}
          // Listening is not editing: a Viewer hears the line. The check
          // beside it still refuses their vote (`canValidate` there).
          onClick={(event) => {
            event.stopPropagation()
            if (loading) return
            onToggle()
          }}
          disabled={loading}
          className={cn(
            "relative flex h-6 w-6 items-center justify-center rounded-lg",
            "transition-[transform,color,background-color] duration-150 ease-out",
            "active:scale-[0.88] disabled:cursor-not-allowed disabled:opacity-30 hover:bg-muted/80",
            playing
              ? "text-primary hover:text-primary"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {playing
            ? <Pause className="h-3.5 w-3.5" strokeWidth={2.5} />
            : <Play className="h-3.5 w-3.5" strokeWidth={2.5} />}
        </button>
      </AppTooltip>
    </div>
  )
}
