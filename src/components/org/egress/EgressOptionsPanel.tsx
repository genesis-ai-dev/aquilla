// Data egress options — what the export contains. Controlled by the page:
// options come from per-org prefs (src/lib/store/egress-prefs.ts) and every
// change is persisted immediately, so an org's configuration survives visits.

import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Section } from "@/components/ui/page"
import {
  EGRESS_CONVERT_FORMATS,
  type EgressAudioMode,
  type EgressConvertFormat,
  type EgressOptions,
  type EgressTextMode,
} from "@/lib/egress/types"
import type { EgressLaneOption } from "@/hooks/useOrgEgressData"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export interface EgressEstimate {
  files: number
  cells: number
  recordedMs: number
}

/** True when the current options produce zero zip entries: text needs a mode
 *  AND at least one lane; otherwise only audio or source docs can contribute.
 *  The page disables Export on this — an empty archive helps nobody. */
export function egressProducesNothing(options: EgressOptions): boolean {
  const textProduces = options.textMode !== "none" && options.lanes.length > 0
  return !textProduces && options.audioMode === "none" && !options.includeSourceDocs
}

const TEXT_MODES: { value: EgressTextMode; labelKey: MessageKey; descriptionKey: MessageKey }[] = [
  {
    value: "original",
    labelKey: "org.egress.options.text.original.label",
    descriptionKey: "org.egress.options.text.original.description",
  },
  {
    value: "convert",
    labelKey: "org.egress.options.text.convert.label",
    descriptionKey: "org.egress.options.text.convert.description",
  },
  {
    value: "none",
    labelKey: "org.egress.options.text.none.label",
    descriptionKey: "org.egress.options.text.none.description",
  },
]

const AUDIO_MODES: { value: EgressAudioMode; labelKey: MessageKey; descriptionKey: MessageKey }[] = [
  { value: "none", labelKey: "common.none", descriptionKey: "org.egress.options.audio.none.description" },
  {
    value: "separate-clips",
    labelKey: "org.egress.options.audio.separate.label",
    descriptionKey: "org.egress.options.audio.separate.description",
  },
  {
    value: "file-clip",
    labelKey: "org.egress.options.audio.file.label",
    descriptionKey: "org.egress.options.audio.file.description",
  },
  {
    value: "voice-clips",
    labelKey: "org.egress.options.audio.voice.label",
    descriptionKey: "org.egress.options.audio.voice.description",
  },
  {
    value: "voice-timeline",
    labelKey: "org.egress.options.audio.timeline.label",
    descriptionKey: "org.egress.options.audio.timeline.description",
  },
]

function radioLabelClass(active: boolean): string {
  return (
    "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
    (active ? "bg-accent/60 ring-1 ring-ring/20" : "hover:bg-accent/40")
  )
}

export function EgressOptionsPanel({
  options,
  onChange,
  laneOptions,
  estimate,
  disabled = false,
}: {
  options: EgressOptions
  onChange: (patch: Partial<EgressOptions>) => void
  laneOptions: EgressLaneOption[]
  estimate: EgressEstimate
  disabled?: boolean
}) {
  const t = useT()
  const toggleLane = (lane: string, checked: boolean) => {
    const next = checked
      ? [...options.lanes, lane]
      : options.lanes.filter((l) => l !== lane)
    onChange({ lanes: next })
  }

  const recordedMin = Math.round(estimate.recordedMs / 60000)

  return (
    <Section title={t("org.egress.options.title")} contentClassName="flex flex-col gap-5">
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("editor.lens.text")}</legend>
        <RadioGroup
          value={options.textMode}
          onValueChange={(v) => onChange({ textMode: v as EgressTextMode })}
          className="flex flex-col gap-0.5"
          aria-label={t("org.egress.options.textMode")}
          disabled={disabled}
        >
          {TEXT_MODES.map((m) => (
            <label key={m.value} className={radioLabelClass(options.textMode === m.value)}>
              <RadioGroupItem value={m.value} className="mt-0.5 shrink-0" aria-label={t(m.labelKey)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm leading-tight font-medium">{t(m.labelKey)}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t(m.descriptionKey)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <Select
          value={options.convertFormat}
          onValueChange={(v) => onChange({ convertFormat: v as EgressConvertFormat })}
          disabled={disabled || options.textMode === "none"}
        >
          <SelectTrigger className="w-full" aria-label={t("org.egress.options.conversionFormat")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EGRESS_CONVERT_FORMATS.map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("org.egress.options.targetLanes")}</legend>
        <div role="group" aria-label={t("org.egress.options.targetLanes")} className="flex flex-col">
          {laneOptions.map((o) => (
            <label key={o.lane || "__default"} className="flex items-center gap-2 py-1 text-sm">
              <Checkbox
                checked={options.lanes.includes(o.lane)}
                onCheckedChange={(c) => toggleLane(o.lane, c === true)}
                aria-label={t("org.egress.options.lane", { lane: o.label })}
                disabled={disabled}
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={options.includeSourceDocs}
          onCheckedChange={(c) => onChange({ includeSourceDocs: c === true })}
          disabled={disabled}
        />
        <span className="flex flex-col gap-0.5">
          {t("org.egress.options.includeSources")}
          <span className="text-xs text-muted-foreground">
            {t("org.egress.options.includeSourcesDescription")}
          </span>
        </span>
      </label>

      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("nav.outbox.previewAudio")}</legend>
        <RadioGroup
          value={options.audioMode}
          onValueChange={(v) => onChange({ audioMode: v as EgressAudioMode })}
          className="flex flex-col gap-0.5"
          aria-label={t("org.egress.options.audioMode")}
          disabled={disabled}
        >
          {AUDIO_MODES.map((m) => (
            <label key={m.value} className={radioLabelClass(options.audioMode === m.value)}>
              <RadioGroupItem value={m.value} className="mt-0.5 shrink-0" aria-label={t(m.labelKey)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm leading-tight font-medium">{t(m.labelKey)}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t(m.descriptionKey)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={options.useCache}
          onCheckedChange={(c) => onChange({ useCache: c === true })}
          disabled={disabled}
        />
        {t("org.egress.options.useCache")}
      </label>

      {egressProducesNothing(options) && (
        <p
          className="text-xs text-amber-700 dark:text-amber-300"
          data-testid="egress-nothing-hint"
        >
          {t("org.egress.options.empty")}
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="egress-estimate">
        {t("org.egress.options.estimate", {
          fileCount: t("search.expanded.fileCount", { count: estimate.files }),
          cellCount: t("common.cellCount", { count: estimate.cells }),
        })}
        {recordedMin > 0 ? t("org.egress.options.estimateAudio", { minutes: recordedMin }) : ""}
      </p>
    </Section>
  )
}
