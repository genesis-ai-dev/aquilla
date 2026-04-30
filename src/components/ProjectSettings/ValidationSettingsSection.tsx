import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  validationCount: number
  validationCountAudio: number
  hasAnyAudioData: boolean
  /** When true, both inputs are disabled (role/offline gate). */
  disabled?: boolean
  /** Tooltip shown on hover when disabled is true. */
  disabledTooltip?: string
  onChange: (
    updates: Partial<Pick<ProjectRecord, "validationCount" | "validationCountAudio">>
  ) => void
}

/**
 * Settings card for required validator counts. Audio input is disabled when
 * the project has no audio data yet — we don't hide it so users know the
 * axis exists.
 */
export function ValidationSettingsSection({
  validationCount,
  validationCountAudio,
  hasAnyAudioData,
  disabled = false,
  disabledTooltip,
  onChange,
}: Props) {
  function clamp(raw: string): number {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return 1
    if (n < 1) return 1
    if (n > 15) return 15
    return n
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="validation-count">Required validators (text)</Label>
          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-block" />}>
                <Input
                  id="validation-count"
                  type="number"
                  min={1}
                  max={15}
                  disabled={disabled}
                  value={validationCount}
                  onChange={(e) => onChange({ validationCount: clamp(e.target.value) })}
                  className="w-24"
                />
              </TooltipTrigger>
              {disabled && disabledTooltip && (
                <TooltipContent>{disabledTooltip}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <p className="text-xs text-muted-foreground">
            Cells need this many distinct validators to count as fully validated.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="validation-count-audio">Required validators (audio)</Label>
          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-block" />}>
                <Input
                  id="validation-count-audio"
                  type="number"
                  min={1}
                  max={15}
                  disabled={disabled || !hasAnyAudioData}
                  value={validationCountAudio}
                  onChange={(e) => onChange({ validationCountAudio: clamp(e.target.value) })}
                  className="w-24"
                />
              </TooltipTrigger>
              {disabled && disabledTooltip && (
                <TooltipContent>{disabledTooltip}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <p className="text-xs text-muted-foreground">
            {hasAnyAudioData
              ? "Applies to audio translations."
              : "Enabled once audio translations exist."}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
