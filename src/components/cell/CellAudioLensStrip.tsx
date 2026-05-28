// The per-cell Audio-lens strip shown beneath the target editor when the
// editor is in Audio mode: which character voices this line, its voicing
// status, and a generate / regenerate action. Errors surface in the row's
// gutter SynthStatusBadge, so this strip stays compact.

import { CheckCircle2, Loader2, RefreshCw, Volume2 } from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { cn } from "@/lib/utils"
import type { Voice } from "@/lib/parsers/types"

export function CellAudioLensStrip({
  cellId, voice, voices, hasGeneratedVoice, disabled, onAssign, onGenerate,
}: {
  cellId: string
  /** The cast member assigned to this line. */
  voice: Voice | undefined
  voices: Voice[]
  hasGeneratedVoice: boolean
  disabled?: boolean
  onAssign: (voiceId: string) => void
  onGenerate: () => void
}) {
  const status = useTtsStatus(ttsStatusKey(cellId))
  const isBusy = status.kind === "loading" || status.kind === "synthesizing"

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SpeakerChip voice={voice} voices={voices} onAssign={onAssign} />

      <div className="w-16 text-xs">
        {isBusy ? (
          <span className="inline-flex items-center gap-1 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> Voicing
          </span>
        ) : hasGeneratedVoice ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> Ready
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onGenerate}
        disabled={isBusy || disabled}
        title={hasGeneratedVoice ? "Regenerate audio" : "Generate audio"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-neu-sm transition-all",
          "hover:shadow-neu active:shadow-neu-pressed disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" />
          : hasGeneratedVoice ? <RefreshCw className="h-3 w-3" />
          : <Volume2 className="h-3 w-3" />}
        {hasGeneratedVoice ? "Regenerate" : "Generate"}
      </button>
    </div>
  )
}
