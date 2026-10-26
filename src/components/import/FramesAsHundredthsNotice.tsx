import { AlertTriangle, Info } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FrameRateLabel, FramesAsHundredths } from "@/lib/parsers/frame-timecode"

/** What the person chose for one file: a frame rate to convert at, or keep. */
export type FramesAsHundredthsChoice = FrameRateLabel | "keep"

/**
 * The import preview's warning for a subtitle file whose every cue time is a
 * video frame number written as hundredths of a second (AQU-2197), with the
 * one decision only the person can make: the file's frame rate. Starts on
 * converting at the suggested rate, because the times as written are wrong;
 * keeping them is one click away.
 */
export function FramesAsHundredthsNotice({
  finding,
  choice,
  onChange,
}: {
  finding: FramesAsHundredths
  choice: FramesAsHundredthsChoice
  onChange: (choice: FramesAsHundredthsChoice) => void
}) {
  const t = useT()
  const rate: FrameRateLabel = choice === "keep" ? finding.suggested : choice
  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
      data-testid="frames-as-hundredths"
    >
      <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium">{t("importExport.framesAsHundredths.warning")}</span>
        <Tooltip>
          <TooltipTrigger
            closeOnClick={false}
            render={
              <button
                type="button"
                aria-label={t("importExport.framesAsHundredths.infoLabel")}
                data-testid="frames-as-hundredths-info"
                className="inline-flex shrink-0 text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
              />
            }
          >
            <Info className="mt-px size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {t("importExport.framesAsHundredths.explain", { max: finding.maxFrame })}
          </TooltipContent>
        </Tooltip>
      </div>
      <RadioGroup
        value={choice === "keep" ? "keep" : "convert"}
        onValueChange={(value) => onChange(value === "keep" ? "keep" : rate)}
        className="gap-1.5 ps-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="convert" data-testid="frames-as-hundredths-convert" />
            <span>{t("importExport.framesAsHundredths.convertAt")}</span>
          </label>
          <Select<FrameRateLabel>
            value={rate}
            onValueChange={(value) => { if (value) onChange(value) }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("importExport.framesAsHundredths.rateLabel")}
              data-testid="frames-as-hundredths-rate"
              className="bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {finding.rates.map((label) => (
                <SelectItem key={label} value={label} data-testid={`frames-as-hundredths-rate-${label}`}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>{t("importExport.framesAsHundredths.fps")}</span>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <RadioGroupItem value="keep" data-testid="frames-as-hundredths-keep" />
          <span>{t("importExport.framesAsHundredths.keep")}</span>
        </label>
      </RadioGroup>
    </div>
  )
}
