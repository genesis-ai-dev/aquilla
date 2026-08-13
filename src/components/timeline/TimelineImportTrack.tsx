// AQU-904 — the timeline toolbar's "add a cue file as a track" pair.
//
// Two buttons, not one with a picker: which KIND of cue file this is decides
// how the new track is labelled, and a dubbing team knows which of the two
// files in their hand they are reaching for. Both accept VTT and SRT.
//
// The control owns only the busy/error state of its own pick; the actual import
// (parse → emit → flush → revalidate) belongs to the workspace.

import { useState } from "react"
import { FileText, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { TRACK_FILE_ACCEPT } from "@/lib/timeline/import-vtt-track"
import type { TimelineTrackKind } from "@/lib/timeline/tracks"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

const KIND_KEYS: Record<TimelineTrackKind, { label: MessageKey; tooltip: MessageKey }> = {
  subtitle: {
    label: "editor.timeline.importSubtitleTrack",
    tooltip: "editor.timeline.importSubtitleTrackTooltip",
  },
  audio: {
    label: "editor.timeline.importAudioTrack",
    tooltip: "editor.timeline.importAudioTrackTooltip",
  },
}

export interface TimelineImportTrackProps {
  /** Rejects with a human-readable reason; the message lands in the error row. */
  onImportTrack(file: File, kind: TimelineTrackKind): Promise<void>
}

export function TimelineImportTrack({ onImportTrack }: TimelineImportTrackProps) {
  const t = useT()
  const [busy, setBusy] = useState<TimelineTrackKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File, kind: TimelineTrackKind) => {
    setBusy(kind)
    setError(null)
    try {
      await onImportTrack(file, kind)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const button = (kind: TimelineTrackKind) => (
    <AppTooltip content={t(KIND_KEYS[kind].tooltip)}>
      <label
        data-testid={`tl-import-${kind}-track`}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-muted",
          busy != null && "pointer-events-none opacity-50",
        )}
      >
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        {t(KIND_KEYS[kind].label)}
        <input
          type="file"
          className="hidden"
          accept={TRACK_FILE_ACCEPT}
          disabled={busy != null}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void pick(file, kind)
          }}
        />
      </label>
    </AppTooltip>
  )

  return (
    <>
      {busy != null ? (
        <span
          data-testid="tl-import-track-busy"
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground"
        >
          <Spinner /> {t("editor.timeline.importingTrack")}
        </span>
      ) : (
        <>
          {button("subtitle")}
          {button("audio")}
        </>
      )}
      {error && (
        <span
          data-testid="tl-import-track-error"
          className="inline-flex items-center gap-1 text-xs text-destructive"
        >
          {t("editor.timeline.importTrackFailed", { message: error })}
          <button
            type="button"
            aria-label={t("common.dismiss")}
            onClick={() => setError(null)}
            className="rounded p-0.5 hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </>
  )
}
