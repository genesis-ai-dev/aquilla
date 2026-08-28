// Mic button in the cell gutter. Clicking opens the AudioRecordingModal at
// the workspace level — the modal owns the full capture flow (countdown,
// waveform, duration bar, preview/retake/save, rapid next/prev navigation).

import { useRef, useState } from "react"
import { Mic, MicOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  onOpenRecording: () => void
  disabled?: boolean
  /** Pass true when mic permission is known to be denied — renders a help
   *  popover explaining how to re-enable access instead of just a tooltip. */
  micDenied?: boolean
}

export function getUnsupportedReason(): string | null {
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

export function CellAudioRecordButton({ onOpenRecording, disabled, micDenied }: Props) {
  const t = useT()
  const [showDeniedHelp, setShowDeniedHelp] = useState(false)
  const helpAnchorRef = useRef<HTMLSpanElement>(null)
  const unsupportedReason = getUnsupportedReason()
  const blocked = disabled || unsupportedReason !== null || micDenied
  // `unsupportedReason` is a browser-capability diagnostic produced outside any
  // component, so it stays English (AQU-510) — only the frame around it is keyed.
  const tooltip = micDenied
    ? t("editor.audio.micBlockedTooltip")
    : unsupportedReason
      ? `Recording unavailable — ${unsupportedReason}`
      : disabled
        ? t("editor.audio.recordingDisabled")
        : t("editor.audio.record")

  const handleClick = () => {
    if (micDenied) { setShowDeniedHelp((v) => !v); return }
    if (!blocked) onOpenRecording()
  }

  return (
    <span ref={helpAnchorRef} className="relative inline-flex">
      <AppTooltip content={tooltip}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={handleClick}
          // NEVER disable when micDenied — that kills mouse events and makes
          // the help popover unreachable.
          disabled={Boolean(disabled || unsupportedReason) && !micDenied}
          aria-label={tooltip}
          className={cn(
            "rounded-full",
            blocked
              ? micDenied
                ? "text-amber-500/70 hover:text-amber-500"
                : "text-muted-foreground/20"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
        >
          {blocked ? <MicOff /> : <Mic />}
        </Button>
      </AppTooltip>

      {micDenied && showDeniedHelp && (
        <Popover open onOpenChange={(open) => { if (!open) setShowDeniedHelp(false) }}>
          <PopoverContent
            anchor={helpAnchorRef}
            side="bottom"
            align="center"
            className="w-52 gap-1 p-3 text-[11px] leading-snug"
          >
            <PopoverTitle className="text-[11px] font-semibold">
              {t("editor.audio.micBlockedTitle")}
            </PopoverTitle>
            <PopoverDescription className="text-[11px] leading-snug">
              {t("editor.audio.micBlockedHelp")}
            </PopoverDescription>
            <button
              type="button"
              onClick={() => setShowDeniedHelp(false)}
              className="mt-1 self-start text-[10px] underline text-muted-foreground hover:text-foreground"
            >
              {t("common.dismiss")}
            </button>
          </PopoverContent>
        </Popover>
      )}
    </span>
  )
}
