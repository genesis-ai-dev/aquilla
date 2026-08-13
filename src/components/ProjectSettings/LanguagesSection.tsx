// LanguagesSection — AQU-538 slice 2 "project settings UI: manage target lanes".
//
// Project-data-model decision (docs/superpowers/specs/2026-07-11-project-data-model-decision.md):
// one source, N target lanes; '' (the empty string) is the default lane and is
// always omitted on the wire. This section shows the default target language
// (read-only — set on Project Info) plus the registry of *extra* named lanes
// stored in `settings.targetLanes`.
//
// AQU-601: lanes are ARCHIVED, not deleted. Archiving records a lane's tag in
// `settings.archivedLanes` — the lane stays in `targetLanes` (its cell data and
// deep links keep working) but drops out of the active list here and out of the
// workspace lane switcher's default view. Restoring drops the tag from
// `archivedLanes`. See src/components/project-lane-archive.ts for the split.
//
// Writes go through the SAME `patchShared` (useProjectSettings.patch) instance
// the rest of ProjectSettings uses for shared fields — server-side conflict
// (409) and role-floor (403) handling is therefore identical to every other
// shared-settings field on this page; `sharedConflict` in the parent already
// renders the "Settings changed elsewhere" banner when the hook detects one.
import { useState } from "react"
import { Globe, Archive, ArchiveRestore, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import { activeLanes, archivedRegisteredLanes } from "@/components/project-lane-archive"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

const MAX_LANE_LENGTH = 64

export interface LanguagesSectionProps {
  /** The project's default target language — read-only here, edited on the
   *  "Project Info" section. Corresponds to the '' (default) lane. */
  defaultTargetLanguage: string
  /** Extra named target lanes currently registered on the project (includes
   *  archived tags — split locally via project-lane-archive). */
  targetLanes: string[]
  /** AQU-601: subset of `targetLanes` that is archived (hidden by default). */
  archivedLanes?: string[]
  /** Whether the caller is authorized to write shared settings (mirrors the
   *  server's MAINTAINER 600 floor for the settings PATCH). */
  canEdit: boolean
  /** Human-readable reason write controls are disabled (offline / role), or
   *  null when `canEdit` is true. Mirrors `sharedDisabledTooltip` in
   *  ProjectSettings.tsx. */
  disabledTooltip: string | null
  /** The shared-settings patch function (ProjectSettings.tsx's `patchShared`,
   *  i.e. `useProjectSettings(...).patch`). Optimistic-conflict / role /
   *  offline handling all live in that hook already — this component only
   *  has to react to the returned outcome. */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

function normalizeLane(lane: string): string {
  return lane.trim()
}

function validateNewLane(
  candidate: string,
  defaultTargetLanguage: string,
  existingLanes: string[],
  t: TFunction,
): string | null {
  const trimmed = normalizeLane(candidate)
  if (!trimmed) return t("projectSettings.create.extraLanguagesEmptyError")
  if (trimmed.length > MAX_LANE_LENGTH) {
    return t("projectSettings.create.extraLanguagesTooLongError", { max: MAX_LANE_LENGTH })
  }
  const lower = trimmed.toLowerCase()
  if (lower === defaultTargetLanguage.trim().toLowerCase()) {
    return t("projectSettings.languages.alreadyDefaultError")
  }
  if (existingLanes.some((l) => l.toLowerCase() === lower)) {
    return t("projectSettings.languages.alreadyExistsError")
  }
  return null
}

function outcomeMessage(outcome: PatchOutcome, t: TFunction): string | null {
  if (outcome.kind === "ok") return null
  if (outcome.kind === "conflict") {
    return t("projectSettings.languages.conflictError")
  }
  if (outcome.kind === "blocked") {
    return outcome.reason === "offline"
      ? t("projectSettings.languages.offlineError")
      : t("projectSettings.languages.permissionError")
  }
  return outcome.message || t("projectSettings.languages.savingFailedGeneric")
}

export function LanguagesSection({
  defaultTargetLanguage,
  targetLanes,
  archivedLanes = [],
  canEdit,
  disabledTooltip,
  patch,
}: LanguagesSectionProps) {
  const t = useT()
  const [newLane, setNewLane] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingArchive, setPendingArchive] = useState<string | null>(null)
  const [laneActionError, setLaneActionError] = useState<string | null>(null)
  const [busyLane, setBusyLane] = useState<string | null>(null)

  const active = activeLanes(targetLanes, archivedLanes)
  const archived = archivedRegisteredLanes(targetLanes, archivedLanes)

  async function handleAdd() {
    if (!canEdit) return
    const trimmed = normalizeLane(newLane)
    // Dedupe against every registered lane (active + archived) so a tag can't
    // be re-added while an archived copy still holds its cell data.
    const validationError = validateNewLane(trimmed, defaultTargetLanguage, targetLanes, t)
    if (validationError) {
      setAddError(validationError)
      return
    }
    setAddError(null)
    setAdding(true)
    try {
      const outcome = await patch({ targetLanes: [...targetLanes, trimmed] } as ProjectWideSettings)
      const message = outcomeMessage(outcome, t)
      if (message) {
        setAddError(message)
        return
      }
      setNewLane("")
    } finally {
      setAdding(false)
    }
  }

  async function handleConfirmArchive(lane: string) {
    if (!canEdit) return
    setLaneActionError(null)
    setBusyLane(lane)
    try {
      const outcome = await patch({
        archivedLanes: [...archivedLanes, lane],
      } as ProjectWideSettings)
      const message = outcomeMessage(outcome, t)
      if (message) {
        setLaneActionError(message)
        return
      }
      setPendingArchive(null)
    } finally {
      setBusyLane(null)
    }
  }

  async function handleRestore(lane: string) {
    if (!canEdit) return
    setLaneActionError(null)
    setBusyLane(lane)
    try {
      const outcome = await patch({
        archivedLanes: archivedLanes.filter((l) => l !== lane),
      } as ProjectWideSettings)
      const message = outcomeMessage(outcome, t)
      if (message) {
        setLaneActionError(message)
      }
    } finally {
      setBusyLane(null)
    }
  }

  return (
    <Card id="section-languages">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.section.languages")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <FieldLabel>{t("projectSettings.languages.defaultTargetLabel")}</FieldLabel>
          <p className="mt-1 text-sm text-foreground">{defaultTargetLanguage || "—"}</p>
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.languages.defaultTargetNote")}
          </p>
        </div>

        <div>
          <FieldLabel>{t("projectSettings.languages.additionalLanesLabel")}</FieldLabel>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("projectSettings.languages.additionalLanesDescription")}
          </p>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.languages.noAdditionalLanes")}</p>
          ) : (
            <ul data-testid="target-lanes-list" className="flex flex-col gap-1">
              {active.map((lane) => (
                <li
                  key={lane}
                  className="flex items-center gap-2 rounded border bg-card px-2 py-1.5 text-sm"
                >
                  <Badge variant="outline" className="shrink-0">
                    {lane}
                  </Badge>
                  <span className="flex-1" />
                  {pendingArchive === lane ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t("projectSettings.languages.archiveConfirm", { lane })}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busyLane === lane}
                        onClick={() => void handleConfirmArchive(lane)}
                      >
                        {busyLane === lane ? t("projectSettings.languages.archivingButton") : t("projectSettings.languages.confirmArchiveButton")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyLane === lane}
                        onClick={() => setPendingArchive(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        disabled={!canEdit}
                        data-testid={`archive-lane-${lane}`}
                        aria-label={t("projectSettings.languages.archiveLaneAriaLabel", { lane })}
                        onClick={() => {
                          setLaneActionError(null)
                          setPendingArchive(lane)
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </DisabledFieldTooltip>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {archived.length > 0 && (
          <div>
            <FieldLabel>{t("projectSettings.languages.archivedLanesLabel")}</FieldLabel>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("projectSettings.languages.archivedLanesDescription")}
            </p>
            <ul data-testid="archived-lanes-list" className="flex flex-col gap-1">
              {archived.map((lane) => (
                <li
                  key={lane}
                  className="flex items-center gap-2 rounded border border-dashed bg-muted/40 px-2 py-1.5 text-sm"
                >
                  <Badge variant="secondary" className="shrink-0 text-muted-foreground">
                    {lane}
                  </Badge>
                  <span className="flex-1" />
                  <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 gap-1"
                      disabled={!canEdit || busyLane === lane}
                      data-testid={`restore-lane-${lane}`}
                      aria-label={t("projectSettings.languages.restoreLaneAriaLabel", { lane })}
                      onClick={() => void handleRestore(lane)}
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      {busyLane === lane ? t("projectSettings.languages.restoringButton") : t("common.restore")}
                    </Button>
                  </DisabledFieldTooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {laneActionError && <p className="text-xs text-destructive">{laneActionError}</p>}

        <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <FieldLabel htmlFor="add-target-lang">{t("projectSettings.languages.addLaneLabel")}</FieldLabel>
              <Input
                id="add-target-lang"
                data-testid="add-target-lang-input"
                value={newLane}
                onChange={(e) => {
                  setNewLane(e.target.value)
                  setAddError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void handleAdd()
                  }
                }}
                placeholder={t("projectSettings.create.extraLanguagesPlaceholder")}
                disabled={!canEdit || adding}
              />
            </div>
            <Button
              data-testid="add-target-lang-btn"
              onClick={() => void handleAdd()}
              disabled={!canEdit || adding}
            >
              <Plus className="me-1 h-3.5 w-3.5" />
              {adding ? t("common.adding") : t("projectSettings.languages.addLaneButton")}
            </Button>
          </div>
        </DisabledFieldTooltip>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
        {!canEdit && disabledTooltip && (
          <p className="text-xs text-muted-foreground">{disabledTooltip}</p>
        )}
      </CardContent>
    </Card>
  )
}
