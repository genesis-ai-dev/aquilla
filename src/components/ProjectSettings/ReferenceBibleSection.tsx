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
import { Button } from "@/components/ui/button"
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
  /** Bumped by "Retry" to load the list again. */
  const [attempt, setAttempt] = useState(0)
  const [busyLane, setBusyLane] = useState<string | null>(null)
  const [errorLane, setErrorLane] = useState<{ lane: string; message: string } | null>(null)

  // Re-runs when the session token refreshes (loadVersions changes) and on
  // "Retry". A later success clears an earlier failure; a failed refetch keeps
  // a list that already loaded rather than replacing it with the error.
  useEffect(() => {
    let cancelled = false
    loadVersions()
      .then((list) => {
        if (cancelled) return
        setVersions(list)
        setLoadFailed(false)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [loadVersions, attempt])

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

  // A lane can name a Bible the server lacks (copied settings, a database the
  // loader has not run on): its row still shows, so the choice can be seen and
  // cleared, even when no Bible at all is installed.
  const anyChosen = rows.some((row) => referenceBibleForLane(settings, row.tag) !== null)

  let body: ReactNode
  if (versions === null && loadFailed) {
    body = (
      <SettingsBlock className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{t("projectSettings.referenceBible.loadFailed")}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="reference-bible-retry"
          onClick={() => {
            setLoadFailed(false)
            setAttempt((n) => n + 1)
          }}
        >
          {t("common.retry")}
        </Button>
      </SettingsBlock>
    )
  } else if (versions === null) {
    body = (
      <SettingsBlock className="text-sm text-muted-foreground">
        {t("projectSettings.referenceBible.loading")}
      </SettingsBlock>
    )
  } else if (versions.length === 0 && !anyChosen) {
    body = (
      <SettingsBlock className="text-sm text-muted-foreground" data-testid="reference-bible-none-installed">
        {t("projectSettings.referenceBible.noneInstalled")}
      </SettingsBlock>
    )
  } else {
    const installedList = versions
    const laneRows = rows.map((row) => {
      const current = referenceBibleForLane(settings, row.tag)
      const installed = current ? installedList.some((v) => v.id === current) : true
      const sorted = sortBiblesForLane(installedList, row.language)
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
    body = installedList.length === 0 ? (
      <>
        <SettingsBlock className="text-sm text-muted-foreground" data-testid="reference-bible-none-installed">
          {t("projectSettings.referenceBible.noneInstalled")}
        </SettingsBlock>
        {laneRows}
      </>
    ) : (
      laneRows
    )
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
