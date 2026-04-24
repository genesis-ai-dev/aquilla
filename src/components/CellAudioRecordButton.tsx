// Mic button in the cell gutter. Clicking opens the AudioRecordingModal at
// the workspace level — the modal owns the full capture flow (countdown,
// waveform, duration bar, preview/retake/save, rapid next/prev navigation).

import { Mic } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  project: ProjectRecord
  onOpenRecording: () => void
  disabled?: boolean
}

function isSupported(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false
  if (typeof MediaRecorder === "undefined") return false
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false
  return true
}

export function CellAudioRecordButton({ project, onOpenRecording, disabled }: Props) {
  if (!isSupported()) return null

  const isGitProject = project.origin?.kind === "git"
  const blocked = disabled || isGitProject
  const tooltip = disabled
    ? "Recording disabled"
    : isGitProject
      ? "Recording on GitLab projects isn't available yet"
      : "Record audio"

  return (
    <button
      type="button"
      onClick={() => { if (!blocked) onOpenRecording() }}
      disabled={blocked}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
        blocked
          ? "cursor-not-allowed text-muted-foreground/20"
          : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      <Mic className="h-3 w-3" />
    </button>
  )
}
