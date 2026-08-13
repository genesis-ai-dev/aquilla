// The video column's header — the same row the chip strip provides for the
// text column (2026-08-08, Sam's sketch): identical chrome so the two read as
// one line split by the divider. The pill carries the linked file's name.
//
// Extracted 2026-08-11: both the pane and its error card render this, so it
// cannot live inside either of them.
//
// Stage 2 (2026-08-13) hangs the source mute off the right of this same row.
// It used to be a speaker button on the timeline's Source-audio track; that
// track is cue data now and mutes nothing, while the thing being silenced —
// the film's own soundtrack — is right here. Two constraints shape it:
// the button is ICON-ONLY, because a browser pass reads this header's
// textContent; and it is no taller than the name pill beside it, because this
// row's height is kept in lockstep with MediaTextHeader's (see the note in
// ProjectWorkspace around the media-video/media-table panels).

import { Volume2, VolumeX } from "lucide-react"

import { cn } from "@/lib/utils"

export interface VideoPaneHeaderProps {
  src: string
  /** Omitted whenever there is no soundtrack of ours to silence: a slaved
   *  picture is force-muted by the queue, and the error card has no element at
   *  all. Both simply pass nothing, and that absence is the whole gate. */
  muteControl?: { audible: boolean; onToggle(): void }
}

export function VideoPaneHeader({ src, muteControl }: VideoPaneHeaderProps) {
  let basename = src
  try {
    basename = decodeURIComponent(new URL(src).pathname.split("/").pop() || src)
  } catch {
    /* not a parseable URL — show it raw */
  }
  return (
    <div
      data-testid="video-pane-header"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-4 py-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">Video</span>
      <span className="inline-flex min-w-0 items-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
        <span className="truncate font-mono">{basename}</span>
      </span>
      {muteControl && (
        <button
          type="button"
          data-testid="video-pane-mute"
          aria-label={muteControl.audible ? "Mute the video's sound" : "Unmute the video's sound"}
          aria-pressed={muteControl.audible}
          title={
            muteControl.audible
              ? "The video's sound is on — click to mute"
              : "The video is muted — click to unmute"
          }
          onClick={muteControl.onToggle}
          // The name pill's exact box, so the pill goes on setting the row's
          // height whatever this button is doing; `ml-auto` pushes it to the
          // right edge without a spacer element. Palette matches the speaker
          // buttons this replaced, so the state still reads at a glance.
          className={cn(
            "ml-auto inline-flex shrink-0 items-center rounded-md border border-border px-2 py-0.5",
            muteControl.audible
              ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
              : "bg-background text-foreground/50 hover:bg-muted",
          )}
        >
          {muteControl.audible ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
        </button>
      )}
    </div>
  )
}
