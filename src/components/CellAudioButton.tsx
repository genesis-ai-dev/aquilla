// src/components/CellAudioButton.tsx
// Compact ▶/⏸ button. The audio controller is owned by the parent EditorRow
// so the button and the waveform stay in lock-step on play / pause / seek.
// AQU-238: aria-label mirrors title so screen-readers and test selectors work.

import type { ReactNode } from "react"
import { AlertCircle, CloudDownload, CloudOff, FileQuestion, Pause, Play, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"
import { AppTooltip } from "@/components/ui/tooltip"

interface Props {
  controller: UseCellAudioResult
  hidden?: boolean
}

export function CellAudioButton({ controller, hidden }: Props) {
  if (hidden) return null
  const { state, error, isPlaying, play, pause } = controller

  const onClick = () => {
    if (state === "loading") return
    if (isPlaying) { pause(); return }
    void play()
  }

  const tooltip =
    state === "error" && error
      ? errorTooltip(error.kind)
      : state === "cloud"
        ? "Audio on server — click to download and play"
        : isPlaying
          ? "Pause audio"
          : "Play audio"

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      onPointerEnter={state === "cloud" ? () => { void play() } : undefined}
      disabled={state === "loading"}
      aria-label={tooltip}
      className={cn(
        state === "error"
          ? "text-destructive hover:text-destructive/80"
          : state === "cloud"
            ? "text-sky-500/70 hover:text-sky-500"
            : isPlaying
              ? "text-primary"
              : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      {state === "loading" && <Spinner className="size-3" />}
      {state === "error" && errorIcon(error?.kind)}
      {state === "cloud" && <CloudDownload />}
      {state !== "loading" && state !== "error" && state !== "cloud" && (isPlaying
        ? <Pause />
        : <Play />
      )}
    </Button>
  )

  return (
    <AppTooltip content={tooltip}>
      {button}
    </AppTooltip>
  )
}

type ErrorIconKind = "pointer-missing" | "pointer-invalid" | "no-session" | "no-git-origin" | "batch-failed" | "audio-deleted"

const ERROR_ICON: Readonly<Record<ErrorIconKind, ReactNode>> = {
  "pointer-missing": <FileQuestion />,
  "pointer-invalid": <FileQuestion />,
  "no-session": <CloudOff />,
  "no-git-origin": <CloudOff />,
  "batch-failed": <CloudOff />,
  // F10: permanent deletion — show a trash icon instead of a generic error
  "audio-deleted": <Trash2 />,
}

function errorIcon(kind: string | undefined) {
  return (kind && kind in ERROR_ICON ? ERROR_ICON[kind as ErrorIconKind] : undefined) ?? <AlertCircle />
}

const ERROR_TOOLTIP: Readonly<Record<string, string>> = {
  "pointer-missing": "Audio not available — sync the project",
  "pointer-invalid": "Audio format unrecognized",
  "batch-failed": "Couldn't reach audio server",
  "audio-deleted": "Audio was deleted — re-record this cell",
  "download-failed": "Audio download failed — try again",
  "no-session": "Sign in to play audio",
  "no-git-origin": "This project isn't connected to git",
}

function errorTooltip(kind: string): string {
  return ERROR_TOOLTIP[kind] ?? "Audio error"
}
