// src/components/CellAudioButton.tsx
// Compact ▶/⏸ button. The audio controller is owned by the parent EditorRow
// so the button and the waveform stay in lock-step on play / pause / seek.
// AQU-238: aria-label mirrors title so screen-readers and test selectors work.

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
        "rounded-full",
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

function errorIcon(kind: string | undefined) {
  switch (kind) {
    case "pointer-missing":
    case "pointer-invalid":
      return <FileQuestion />
    case "no-session":
    case "no-git-origin":
    case "batch-failed":
      return <CloudOff />
    case "audio-deleted":
      // F10: permanent deletion — show a trash icon instead of a generic error
      return <Trash2 />
    default:
      return <AlertCircle />
  }
}

function errorTooltip(kind: string): string {
  switch (kind) {
    case "pointer-missing": return "Audio not available — sync the project"
    case "pointer-invalid": return "Audio format unrecognized"
    case "batch-failed": return "Couldn't reach audio server"
    case "audio-deleted": return "Audio was deleted — re-record this cell"
    case "download-failed": return "Audio download failed — try again"
    case "no-session": return "Sign in to play audio"
    case "no-git-origin": return "This project isn't connected to git"
    default: return "Audio error"
  }
}
