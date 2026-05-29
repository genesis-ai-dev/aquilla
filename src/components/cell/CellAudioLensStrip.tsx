// The per-cell Audio-lens strip shown beneath the target editor when the
// editor is in Audio mode: which character voices this line and its voicing
// status. Generation now lives in the left rail's VoiceCockpit (batch +
// selection-aware), so this strip is just the speaker chip + a compact status
// indicator. Errors surface in the row's gutter SynthStatusBadge.

import { CheckCircle2, Loader2 } from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import type { Voice } from "@/lib/parsers/types"

export function CellAudioLensStrip({
  cellId, voice, voices, hasGeneratedVoice, onAssign,
}: {
  cellId: string
  /** The cast member assigned to this line. */
  voice: Voice | undefined
  voices: Voice[]
  hasGeneratedVoice: boolean
  onAssign: (voiceId: string) => void
}) {
  const status = useTtsStatus(ttsStatusKey(cellId))
  const isBusy = status.kind === "loading" || status.kind === "synthesizing"

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SpeakerChip voice={voice} voices={voices} onAssign={onAssign} />

      <div className="text-xs">
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
    </div>
  )
}
