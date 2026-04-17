// src/components/CellAudioButton.tsx
// Compact ▶/⏸ button rendered in the cell row when selectedAudioId is set
// and the attachment isn't marked deleted.

import { AlertCircle, Loader2, Pause, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCellAudio } from "@/hooks/useCellAudio"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  project: ProjectRecord
  cell: CodexCell
}

export function CellAudioButton({ project, cell }: Props) {
  const selectedAudioId = cell.metadata?.selectedAudioId
  const attachment = selectedAudioId
    ? cell.metadata?.attachments?.[selectedAudioId]
    : undefined

  if (!attachment || attachment.isDeleted === true) return null

  const { state, error, isPlaying, play, pause } = useCellAudio(project, cell)

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
      {state === "error" && <AlertCircle className="h-3 w-3" />}
      {state !== "loading" && state !== "error" && (isPlaying
        ? <Pause className="h-3 w-3" />
        : <Play className="h-3 w-3" />
      )}
    </button>
  )
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
