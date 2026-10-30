import { useMemo, useState } from "react"
import { AlertTriangle, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { filmFrameRateOf, useFilmFrameRates, type FilmFrameRate } from "@/hooks/useFilmFrameRate"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  convertFramesAsHundredths,
  detectFramesAsHundredths,
  settledRate,
  type FrameRateLabel,
  type FramesAsHundredths,
} from "@/lib/parsers/frame-timecode"
import type { TranslatableString } from "@/lib/parsers/types"

/** What the import does with one file's times: convert them at a frame rate,
 *  or keep them. */
export type FramesAsHundredthsChoice = FrameRateLabel | "keep"

/** What the person has said about one file, if anything: keep the times, and
 *  a frame rate of their own (null = the one worked out for them). */
export interface FramesAsHundredthsPick {
  keep: boolean
  rate: FrameRateLabel | null
}

/** Where the rate to convert at came from, for the sentence that states it:
 *  the linked film's own, the frame numbers', the person's, or not known yet
 *  because the film is still being read. */
export type FrameRateSource = "film" | "frames" | "chosen" | "pending"

export interface FramesAsHundredthsState {
  finding: FramesAsHundredths
  /** What the import applies. */
  choice: FramesAsHundredthsChoice
  /** The rate fixing converts at, even while the person has chosen to keep. */
  rate: FrameRateLabel
  from: FrameRateSource
  keep: boolean
}

/**
 * Settle one file's frame check (AQU-2197). Nobody is asked for a frame rate:
 * a linked film states its own, and that is the one to use when it fits the
 * frame numbers (which cannot tell 24 from 23.976); without one, the frame
 * numbers imply it. Fixing is the starting answer, because the times as
 * written are wrong; the person's own pick wins over both.
 */
export function resolveFramesAsHundredths(
  finding: FramesAsHundredths,
  pick: FramesAsHundredthsPick | null | undefined,
  film: FilmFrameRate,
): FramesAsHundredthsState {
  const auto: { rate: FrameRateLabel; from: FrameRateSource } = film === "pending"
    ? { rate: finding.suggested, from: "pending" }
    : settledRate(finding, film)
  const rate = pick?.rate ?? auto.rate
  const keep = pick?.keep ?? false
  return { finding, choice: keep ? "keep" : rate, rate, from: pick?.rate ? "chosen" : auto.from, keep }
}

/**
 * The one check every VTT import runs on the cues it is about to write
 * (AQU-2197): the finding (null when the times look fine), its settled state —
 * the film's rate or the frame numbers' until the person says otherwise, and
 * back to that when a different file is picked — and the cues with it
 * applied, which is what the import should write. `filmUrl` is the linked
 * film of the file the cues go into; it is read only once the check fires.
 * Pair it with `FramesAsHundredthsNotice` so every path says the same thing.
 */
export function useFramesAsHundredths<T extends TranslatableString>(
  cues: readonly T[] | null | undefined,
  { filmUrl }: { filmUrl?: string | null } = {},
): {
  finding: FramesAsHundredths | null
  state: FramesAsHundredthsState | null
  choice: FramesAsHundredthsChoice
  setPick: (pick: FramesAsHundredthsPick) => void
  cues: readonly T[]
} {
  const finding = useMemo(() => (cues?.length ? detectFramesAsHundredths(cues) : null), [cues])
  const filmRates = useFilmFrameRates(finding ? [filmUrl] : [])
  const [picked, setPicked] = useState<{ cues: unknown; pick: FramesAsHundredthsPick } | null>(null)
  const state = finding
    ? resolveFramesAsHundredths(finding, picked && picked.cues === cues ? picked.pick : null, filmFrameRateOf(filmRates, filmUrl))
    : null
  const choice: FramesAsHundredthsChoice = state?.choice ?? "keep"
  const fixed = useMemo(
    () => (!cues ? [] : choice === "keep" ? cues : convertFramesAsHundredths(cues, choice)),
    [cues, choice],
  )
  return { finding, state, choice, setPick: (pick) => setPicked({ cues, pick }), cues: fixed }
}

const QUIET_LINK =
  "h-auto p-0 align-baseline text-xs text-muted-foreground underline decoration-dashed underline-offset-4 hover:decoration-solid"

/**
 * The import preview's warning for a subtitle file whose every cue time is a
 * video frame number written as hundredths of a second (AQU-2197): one plain
 * action, fix the times or keep them, with the rate the fix uses stated in
 * words and where it came from. The rate is a decision the person never has
 * to make; "Use a different frame rate" is there for the one who knows better.
 */
export function FramesAsHundredthsNotice({
  state,
  onChange,
}: {
  state: FramesAsHundredthsState
  onChange: (pick: FramesAsHundredthsPick) => void
}) {
  const t = useT()
  const { finding } = state
  const [showRates, setShowRates] = useState(false)
  const ownRate = state.from === "chosen" ? state.rate : null
  const fixedHow = {
    film: "importExport.framesAsHundredths.fixFilm",
    frames: "importExport.framesAsHundredths.fixFrames",
    chosen: "importExport.framesAsHundredths.fixChosen",
    pending: "importExport.framesAsHundredths.fixPending",
  } as const
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
        value={state.keep ? "keep" : "fix"}
        onValueChange={(value) => onChange({ keep: value === "keep", rate: ownRate })}
        className="gap-1.5 ps-5"
      >
        <div className="flex flex-col gap-1">
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="fix" data-testid="frames-as-hundredths-fix" />
            <span>{t("importExport.framesAsHundredths.fix")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ps-6 text-muted-foreground">
            <span data-testid="frames-as-hundredths-rate-source" data-from={state.from} data-rate={state.rate}>
              {t(fixedHow[state.from], { rate: state.rate })}
            </span>
            {showRates ? (
              <Select<FrameRateLabel>
                value={state.rate}
                onValueChange={(value) => { if (value) onChange({ keep: false, rate: value }) }}
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
            ) : (
              <Button
                type="button"
                variant="link"
                size="sm"
                className={QUIET_LINK}
                data-testid="frames-as-hundredths-other-rate"
                onClick={() => setShowRates(true)}
              >
                {t("importExport.framesAsHundredths.otherRate")}
              </Button>
            )}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <RadioGroupItem value="keep" data-testid="frames-as-hundredths-keep" />
          <span>{t("importExport.framesAsHundredths.keep")}</span>
        </label>
      </RadioGroup>
    </div>
  )
}
