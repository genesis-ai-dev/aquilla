// Decision 2026-08-05: the timing mode changes the project's STRUCTURE (how
// the whole Media timeline is laid out for everyone), so the switch lives
// here, behind the shared-settings maintainer floor, instead of on the
// timeline toolbar — the toolbar shows a note pointing back here. Visual
// shape mirrors AudioMediaStrategySection; unlike it, this is a SHARED
// setting saved through the page's patchShared diff.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { cn } from "@/lib/utils"
import { AUDIO_TIMING_MODE_LABELS, type AudioTimingMode } from "@/lib/parsers/types"

interface Props {
  value: AudioTimingMode
  onChange: (next: AudioTimingMode) => void
  disabled: boolean
  disabledTooltip?: string | null
}

const ORDER: AudioTimingMode[] = ["dubbing", "audioFirst"]

export function AudioTimingModeSection({ value, onChange, disabled, disabledTooltip }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          How the Media timeline lays the verses out — for everyone on the
          project. Video plays on the original recording's timing, so video
          projects belong in Original's timing.
        </p>
        <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
          <div
            data-testid="settings-timing-mode"
            data-mode={value}
            className="grid gap-2 sm:grid-cols-2"
          >
            {ORDER.map((id) => {
              const label = AUDIO_TIMING_MODE_LABELS[id]
              const selected = value === id
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`settings-timing-mode-${id}`}
                  onClick={() => onChange(id)}
                  disabled={disabled}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors",
                    selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                  aria-pressed={selected}
                >
                  <span className="font-medium">{label.name}</span>
                  <span className="text-xs text-muted-foreground">{label.description}</span>
                </button>
              )
            })}
          </div>
        </DisabledFieldTooltip>
        <p className="text-xs text-muted-foreground">
          Switching is lossless — recordings and timing data are untouched, and
          switching back restores the other view exactly.
        </p>
      </CardContent>
    </Card>
  )
}
