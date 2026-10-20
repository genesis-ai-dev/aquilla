// AQU-1681: the linked-video empty state's step for making this file's rows
// from the video's OWN sound (a video not on YouTube).
//
// Same card and the same shape as the "audio or video file" step beside it: a
// title, what will happen in one or two sentences, one primary action, and
// "Back to captions" underneath. What differs is what the person brings —
// nothing — and how long it takes: an episode's sound is ~50 MB, so the step
// shows how far it has got and offers Cancel until the rows start going in.
//
// A streamed film has one sound track per dub (65 on the client's films). The
// project's source language is chosen for the person; the button beside it
// opens the same searchable list the video's own language menu uses
// (VideoAudioPicker), because sixty-five entries is too many to scroll.

import { useEffect, useRef, useState } from "react"
import { AudioLines, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type {
  LinkedVideoSoundActions,
  VideoSoundRunProgress,
  VideoSoundTrack,
} from "@/lib/timeline/video-sound"

interface LinkedVideoSoundStepProps {
  actions: LinkedVideoSoundActions
  onBack: () => void
  /** The quiet-link look shared with the rest of the card. */
  quietLinkClassName: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function LinkedVideoSoundStep({ actions, onBack, quietLinkClassName }: LinkedVideoSoundStepProps) {
  const t = useT()
  const [choice, setChoice] = useState<{ tracks: VideoSoundTrack[]; defaultTrackId: string | null } | null>(null)
  const [trackId, setTrackId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [progress, setProgress] = useState<VideoSoundRunProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const runRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    actions.describe(ac.signal).then(
      (next) => {
        if (ac.signal.aborted) return
        setChoice(next)
        setTrackId(next.defaultTrackId)
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setError(messageOf(err))
      },
    )
    return () => ac.abort()
  }, [actions])

  // Leaving the card (another file, another view) stops a run that has not
  // started making rows; the attach ignores the signal once it has.
  useEffect(() => () => runRef.current?.abort(), [])

  const start = async () => {
    const ac = new AbortController()
    runRef.current = ac
    setError(null)
    setCancelled(false)
    setProgress({ phase: "download", fraction: 0 })
    try {
      await actions.run(trackId, {
        signal: ac.signal,
        onProgress: (next) => {
          if (!ac.signal.aborted) setProgress(next)
        },
      })
      // Success: stay on "Making rows…" until the rows arrive and this card
      // goes away, so nobody is offered the button a second time meanwhile.
    } catch (err) {
      setProgress(null)
      if (ac.signal.aborted) setCancelled(true)
      else setError(messageOf(err))
    } finally {
      if (runRef.current === ac) runRef.current = null
    }
  }

  const tracks = choice?.tracks ?? []
  const selected = tracks.find((track) => track.id === trackId) ?? null
  const running = progress !== null
  const canCancel = running && (progress.phase === "download" || progress.phase === "save")

  const status = progress === null
    ? null
    : progress.phase === "download"
      ? progress.fraction === null
        ? t("editor.media.linkedVideoSoundDownloading")
        : t("editor.media.linkedVideoSoundDownloadingPercent", { percent: Math.floor(progress.fraction * 100) })
      : progress.phase === "save"
        ? t("editor.media.linkedVideoSoundSaving")
        : t("editor.media.linkedVideoSoundMakingRows")
  const fraction = progress?.phase === "download" ? progress.fraction : null

  return (
    <div className="flex w-full flex-col items-center" data-testid="linked-video-sound-step">
      <AudioLines className="mb-2 h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">{t("editor.media.linkedVideoSoundTitle")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("editor.media.linkedVideoSoundHint")}</p>

      {running ? (
        <div className="mt-4 flex w-full max-w-xs flex-col gap-1.5" data-testid="linked-video-sound-progress">
          <p className="text-xs text-muted-foreground tabular-nums">{status}</p>
          {/* Indeterminate while the size is unknown or nothing is left to
              count (the copy uploading, the rows going in). */}
          <Progress value={fraction === null ? null : Math.round(fraction * 100)} aria-label={status ?? undefined} />
          {canCancel && (
            <Button variant="outline" size="sm" className="mt-2 self-center"
              onClick={() => runRef.current?.abort()}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
      ) : choice === null && error === null ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {t("editor.media.linkedVideoSoundReadingTracks")}
        </p>
      ) : choice !== null ? (
        <>
          {/* One track (or a direct file) has nothing to choose, and a
              control that opens onto a single item is worse than none. */}
          {tracks.length > 1 && (
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("editor.media.linkedVideoSoundTrackLabel")}</span>
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger
                  render={
                    <Button variant="outline" size="sm" data-testid="linked-video-sound-track">
                      {selected?.name ?? t("editor.timeline.audioTrackFilmAudio")}
                      <ChevronDown className="size-3.5 opacity-60" />
                    </Button>
                  }
                />
                <PopoverContent align="center" className="w-64 p-0" data-testid="linked-video-sound-track-menu">
                  <Command>
                    <CommandInput
                      placeholder={t("editor.timeline.audioTrackSearchPlaceholder")}
                      aria-label={t("editor.timeline.audioTrackSearchAria")}
                    />
                    <CommandList>
                      <CommandEmpty>{t("editor.timeline.audioTrackNoMatch")}</CommandEmpty>
                      <CommandGroup heading={t("editor.timeline.audioTrackFilmAudio")}>
                        {tracks.map((track) => {
                          const isActive = track.id === trackId
                          return (
                            <CommandItem
                              key={track.id}
                              // Name AND code are searchable, as in the video's own menu.
                              value={`${track.name} ${track.lang ?? ""}`}
                              onSelect={() => {
                                setTrackId(track.id)
                                setPickerOpen(false)
                              }}
                              data-active={isActive || undefined}
                            >
                              <span className={cn("flex-1 truncate", isActive && "font-medium")}>{track.name}</span>
                              {isActive && <span aria-hidden className="text-xs text-muted-foreground">✓</span>}
                            </CommandItem>
                          )
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}
          <Button className="mt-3" onClick={() => void start()}>
            {t("editor.media.linkedVideoSoundStart")}
          </Button>
        </>
      ) : null}

      {cancelled && <p className="mt-2 text-xs text-muted-foreground">{t("editor.media.linkedVideoSoundCancelled")}</p>}
      {error && <p className="mt-2 text-center text-xs text-destructive" role="alert">{error}</p>}

      {!running && (
        <Button variant="link" size="sm" className={cn("mt-2", quietLinkClassName)} onClick={onBack}>
          {t("editor.media.linkedVideoBackToCaptions")}
        </Button>
      )}
    </div>
  )
}
