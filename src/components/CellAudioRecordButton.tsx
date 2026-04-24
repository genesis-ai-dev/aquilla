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

function getUnsupportedReason(): string | null {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "Browser API unavailable"
  if (typeof MediaRecorder === "undefined") return "MediaRecorder not supported in this browser"
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // On Tauri/WKWebView this usually means NSMicrophoneUsageDescription is
    // missing from Info.plist, or the webview is running in an insecure
    // context. We render the button anyway so the state is discoverable.
    return "Microphone API not exposed — this can happen in Tauri without mic entitlement, or in non-HTTPS contexts"
  }
  return null
}

export function CellAudioRecordButton({ project, onOpenRecording, disabled }: Props) {
  const unsupportedReason = getUnsupportedReason()
  const isGitProject = project.origin?.kind === "git"
  const blocked = disabled || isGitProject || unsupportedReason !== null
  const tooltip = unsupportedReason
    ? `Recording unavailable — ${unsupportedReason}`
    : disabled
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
