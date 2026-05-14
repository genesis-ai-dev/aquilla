// src/components/CellAudioButton.tsx
// Compact ▶/⏸ button. The audio controller is owned by the parent EditorRow
// so the button and the waveform stay in lock-step on play / pause / seek.

import { AlertCircle, CloudOff, FileQuestion, Loader2, Pause, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"

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
      : isPlaying
        ? "Pause audio"
        : "Play audio"

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading"}
      title={tooltip}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
        state === "error"
          ? "text-destructive hover:text-destructive/80"
          : isPlaying
            ? "text-primary"
            : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      {state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === "error" && errorIcon(error?.kind)}
      {state !== "loading" && state !== "error" && (isPlaying
        ? <Pause className="h-3 w-3" />
        : <Play className="h-3 w-3" />
      )}
    </button>
  )
}

function errorIcon(kind: string | undefined) {
  switch (kind) {
    case "pointer-missing":
    case "pointer-invalid":
      return <FileQuestion className="h-3 w-3" />
    case "no-session":
    case "no-git-origin":
    case "batch-failed":
      return <CloudOff className="h-3 w-3" />
    default:
      return <AlertCircle className="h-3 w-3" />
  }
}

function errorTooltip(kind: string): string {
  switch (kind) {
    case "pointer-missing": return "Audio not available — sync the project"
    case "pointer-invalid": return "Audio format unrecognized"
    case "batch-failed": return "Couldn't reach audio server"
    case "download-failed": return "Audio download corrupted — try again"
    case "no-session": return "Sign in to play audio"
    case "no-git-origin": return "This project isn't connected to git"
    default: return "Audio error"
  }
}
