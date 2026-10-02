// AQU-1573: the Bible each target language copies quoted verses from.
//
// One row per active target language (lane): the default lane first, then the
// other registered lanes in registry order; archived lanes are hidden. Each row
// is a dropdown of "None" plus every Bible installed on the server, the ones in
// that lane's language first. A choice saves straight away, like the
// repetition-propagation control, by patching the shared settings blob
// directly rather than riding the page's draft/baseline Save machinery.
//
// The setting is a lane → Bible id map (src/lib/reference-bible/lane-setting.ts).
// Every write goes through withReferenceBibleForLane, so an agent's array form
// or language-name key becomes a clean map on the next change, and choosing
// "None" for the last lane writes {} rather than null (the settings overlay
// skips null and would keep the old choice).

import { useEffect, useState, type ReactNode } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { FieldError } from "@/components/ui/field"
import { SettingsBlock, SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { referenceBibleLaneRows, sortBiblesForLane } from "./reference-bible-rows"
import { referenceBibleForLane, withReferenceBibleForLane } from "@/lib/reference-bible/lane-setting"
import type { ReferenceBibleSummary } from "@/lib/reference-bible/types"
import type { ProjectLaneView, ProjectWideSettings } from "@/lib/sync/project-settings"
import { useT } from "@/lib/i18n/I18nProvider"

/** Sentinel option value for "no Bible" (Base UI Select values are strings). */
const NONE = "__none__"

interface PatchResultLike {
  kind: string
  message?: string
}

export interface ReferenceBibleSectionProps {
  /** The stored `referenceBibleVersions` (map, one-item array, or absent). */
  value: unknown
  /** The project's primary target language: the default lane. */
  targetLanguage: string
  /** The complete lane registry (primary included, archived included). */
  targetLanes: readonly string[]
  archivedLanes?: readonly string[]
  /** Lane rows from settings, for each lane's display name and language code. */
  laneRecords?: readonly ProjectLaneView[]
  /** Loads the installed Bibles (GET /api/v2/reference-bibles). */
  loadVersions: () => Promise<ReferenceBibleSummary[]>
  disabled?: boolean
  disabledTooltip?: ReactNode
  /** Patches the shared settings blob. */
  onPatch: (updates: ProjectWideSettings) => Promise<PatchResultLike>
}

export function ReferenceBibleSection({
  value,
  targetLanguage,
  targetLanes,
  archivedLanes,
  laneRecords,
  loadVersions,
  disabled,
  disabledTooltip,
  onPatch,
}: ReferenceBibleSectionProps) {
  const t = useT()
  const [versions, setVersions] = useState<ReferenceBibleSummary[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busyLane, setBusyLane] = useState<string | null>(null)
  const [errorLane, setErrorLane] = useState<{ lane: string; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    loadVersions()
      .then((list) => {
        if (!cancelled) setVersions(list)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [loadVersions])

  const rows = referenceBibleLaneRows(targetLanguage, targetLanes, archivedLanes, laneRecords)
  const settings = { referenceBibleVersions: value, targetLanguage }

  async function choose(lane: string, next: string) {
    const versionId = next === NONE ? null : next
    setBusyLane(lane)
    setErrorLane(null)
    const result = await onPatch({
      referenceBibleVersions: withReferenceBibleForLane(value, lane, versionId, targetLanguage),
    })
    if (result.kind !== "ok") {
      setErrorLane({ lane, message: result.message || t("projectSettings.referenceBible.saveFailed") })
    }
    setBusyLane(null)
  }

  let body: ReactNode
  if (loadFailed) {
    body = (
      <SettingsBlock className="text-sm text-muted-foreground">
        {t("projectSettings.referenceBible.loadFailed")}
      </SettingsBlock>
    )
  } else if (versions === null) {
    body = (
      <SettingsBlock className="text-sm text-muted-foreground">
        {t("projectSettings.referenceBible.loading")}
      </SettingsBlock>
    )
  } else if (versions.length === 0) {
    body = (
      <SettingsBlock className="text-sm text-muted-foreground" data-testid="reference-bible-none-installed">
        {t("projectSettings.referenceBible.noneInstalled")}
      </SettingsBlock>
    )
  } else {
    body = rows.map((row) => {
      const current = referenceBibleForLane(settings, row.tag)
      const installed = current ? versions.some((v) => v.id === current) : true
      const sorted = sortBiblesForLane(versions, row.language)
      const options = [
        { value: NONE, label: t("projectSettings.referenceBible.none") },
        ...(current && !installed
          ? [{ value: current, label: t("projectSettings.referenceBible.notInstalled", { id: current }) }]
          : []),
        ...sorted.map((v) => ({
          value: v.id,
          label: t("projectSettings.referenceBible.optionLabel", { name: v.name, language: v.languageName }),
        })),
      ]
      const selectId = `reference-bible-${row.tag || "default"}`
      return (
        <SettingsRow
          key={row.tag || "default"}
          label={<label htmlFor={selectId}>{row.label}</label>}
          description={row.tag === "" ? t("projectSettings.referenceBible.defaultLane") : undefined}
          control={
            <div className="flex flex-col items-end gap-1">
              <DisabledFieldTooltip disabled={Boolean(disabled)} tooltip={disabledTooltip ?? null}>
                <Select
                  items={options}
                  disabled={disabled || busyLane !== null}
                  value={current ?? NONE}
                  onValueChange={(v) => {
                    const next = v ?? NONE
                    if (next !== (current ?? NONE)) void choose(row.tag, next)
                  }}
                >
                  <SelectTrigger
                    id={selectId}
                    data-testid={selectId}
                    className="w-64 bg-background"
                    aria-label={t("projectSettings.referenceBible.selectLabel", { lane: row.label })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </DisabledFieldTooltip>
              {errorLane?.lane === row.tag && (
                <FieldError className="text-xs">{errorLane.message}</FieldError>
              )}
            </div>
          }
        />
      )
    })
  }

  return (
    <SettingsGroup
      label={t("projectSettings.section.referenceBible")}
      description={t("projectSettings.referenceBible.description")}
    >
      {body}
    </SettingsGroup>
  )
}
