// The "Bible data" card in Settings → General (AQU-460, AQU-1686).
//
// One master switch (`bibleResourcesEnabled`) and, under it, one row per Bible
// data enrichment (`bibleEnrichments`, db/shared/bible-enrichments.ts). Both
// are edits in the page's deferred Save bar: this component holds no state of
// its own beyond the Data sources dialog, and the parent persists on Save.
//
// Rows are disabled, never hidden, and always say why (the spec forbids
// disabling silently):
//   • Bible data off → every row, with one visible reason above the list;
//   • Autopilot off for the project → the autopilot row, with its own reason;
//   • below maintainer or offline → every switch, with the page's lock hint.
// A disabled row still shows its configured value (explicit choice, else the
// default), so turning Bible data back on shows exactly what will apply.

import { useId, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsBlock, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useFormat } from "@/lib/i18n/format"
import { useT } from "@/lib/i18n/I18nProvider"
import { resolveBibleResourcesEnabled } from "@/lib/parsers/types"
import {
  BIBLE_DATA_SOURCE_SHORT_NAME_KEYS,
  BIBLE_ENRICHMENT_DESCRIPTION_KEYS,
  BIBLE_ENRICHMENT_LABEL_KEYS,
} from "@/lib/bible-data/enrichment-labels"
import {
  BIBLE_ENRICHMENTS,
  BIBLE_ENRICHMENT_IDS,
  type BibleEnrichmentId,
  type BibleEnrichmentSettings,
} from "../../../db/shared/bible-enrichments"
import { BibleDataSourcesDialog } from "./BibleDataSourcesDialog"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"

export interface BibleDataSectionProps {
  /** The explicit master switch being edited; undefined = no explicit choice yet. */
  switchValue: boolean | undefined
  onSwitchChange: (checked: boolean) => void
  /** The explicit enrichment choices being edited. A missing id means its default. */
  enrichments: BibleEnrichmentSettings
  onEnrichmentChange: (id: BibleEnrichmentId, checked: boolean) => void
  hasScriptureFiles: boolean
  canEdit: boolean
  /** Why shared settings are locked (role or offline); shown on a locked switch. */
  lockedTooltip: ReactNode
  /** Is Autopilot on for this project? Its row is disabled with a reason otherwise. */
  autopilotOn: boolean
  /** Opens Rules → Built-in checks. Omit when there is no project to link to. */
  onOpenBuiltinChecks?: () => void
}

export function BibleDataSection({
  switchValue,
  onSwitchChange,
  enrichments,
  onEnrichmentChange,
  hasScriptureFiles,
  canEdit,
  lockedTooltip,
  autopilotOn,
  onOpenBuiltinChecks,
}: BibleDataSectionProps) {
  const t = useT()
  const format = useFormat()
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const switchOffReasonId = useId()
  const autopilotReasonId = useId()
  const switchOn = resolveBibleResourcesEnabled(switchValue, hasScriptureFiles)

  const sourceChip = (id: BibleEnrichmentId) => {
    const { sources, license } = BIBLE_ENRICHMENTS[id]
    return t("bibleData.enrichment.sourceChip", {
      sources: format.isolate(format.list(sources.map((source) => t(BIBLE_DATA_SOURCE_SHORT_NAME_KEYS[source])))),
      license: format.isolate(license),
    })
  }

  return (
    <>
      <SettingsGroup label={t("projectSettings.section.bibleResources")}>
        <SettingsRow
          label={<label htmlFor="bible-resources-enabled">{t("projectSettings.bible.enableLabel")}</label>}
          description={
            <>
              {t("projectSettings.bible.description")}
              {switchValue === undefined && hasScriptureFiles ? (
                <span className="mt-1 block">{t("projectSettings.bible.scriptureDefaultHint")}</span>
              ) : null}
              {switchValue === undefined && !hasScriptureFiles ? (
                <span className="mt-1 block">{t("projectSettings.bible.nonScriptureDefaultHint")}</span>
              ) : null}
              {switchValue === false ? (
                <span className="mt-1 block">{t("projectSettings.bible.disabledHint")}</span>
              ) : null}
            </>
          }
          control={
            <DisabledFieldTooltip disabled={!canEdit} tooltip={lockedTooltip}>
              <Switch
                id="bible-resources-enabled"
                checked={switchOn}
                onCheckedChange={(checked) => onSwitchChange(checked)}
                disabled={!canEdit}
                aria-label={t("projectSettings.bible.enableLabel")}
              />
            </DisabledFieldTooltip>
          }
        />
        {!switchOn ? (
          <SettingsBlock>
            <p id={switchOffReasonId} className="text-xs text-muted-foreground">
              {t("bibleData.enrichment.switchOffReason")}
            </p>
          </SettingsBlock>
        ) : null}
        {BIBLE_ENRICHMENT_IDS.map((id) => {
          const autopilotBlocked = id === "autopilot" && !autopilotOn
          const disabled = !canEdit || !switchOn || autopilotBlocked
          const describedBy = [
            !switchOn ? switchOffReasonId : null,
            autopilotBlocked ? autopilotReasonId : null,
          ].filter(Boolean).join(" ")
          const controlId = `bible-enrichment-${id}`
          return (
            <SettingsRow
              key={id}
              label={<label htmlFor={controlId}>{t(BIBLE_ENRICHMENT_LABEL_KEYS[id])}</label>}
              description={
                <>
                  <span className="block">{t(BIBLE_ENRICHMENT_DESCRIPTION_KEYS[id])}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    {/* Wraps instead of clipping: four sources do not fit one line on a phone. */}
                    <Badge
                      variant="soft"
                      className="h-auto max-w-full whitespace-normal"
                      data-testid={`bible-enrichment-source-${id}`}
                    >
                      {sourceChip(id)}
                    </Badge>
                    {id === "checks" && onOpenBuiltinChecks ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0"
                        onClick={onOpenBuiltinChecks}
                      >
                        {t("bibleData.enrichment.openBuiltinChecks")}
                      </Button>
                    ) : null}
                  </span>
                  {autopilotBlocked ? (
                    <span id={autopilotReasonId} className="mt-1 block">
                      {t("bibleData.enrichment.autopilotOffReason")}
                    </span>
                  ) : null}
                </>
              }
              control={
                <DisabledFieldTooltip disabled={!canEdit} tooltip={lockedTooltip}>
                  <Switch
                    id={controlId}
                    checked={enrichments[id] ?? BIBLE_ENRICHMENTS[id].default}
                    onCheckedChange={(checked) => onEnrichmentChange(id, checked)}
                    disabled={disabled}
                    aria-label={t(BIBLE_ENRICHMENT_LABEL_KEYS[id])}
                    aria-describedby={describedBy || undefined}
                  />
                </DisabledFieldTooltip>
              }
            />
          )
        })}
        <SettingsBlock>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => setSourcesOpen(true)}
          >
            {t("bibleData.sources.open")}
          </Button>
        </SettingsBlock>
      </SettingsGroup>
      <BibleDataSourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </>
  )
}
