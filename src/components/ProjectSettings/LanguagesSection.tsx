// LanguagesSection — AQU-538 slice 2 "project settings UI: manage target lanes",
// AQU-1240 slice 1: `settings.targetLanes` is the COMPLETE lane registry
// (primary included). This section shows the primary target language
// read-only (set on Project Info) and the other registered lanes. The
// primary is not listed again as an additional lane (AQU-1473).
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
import { useEffect, useState, type ReactNode } from "react"
import { Archive, ArchiveRestore, Plus, Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LanguageComboboxInput } from "@/components/LanguageComboboxInput"
import { Badge } from "@/components/ui/badge"
import { FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import type {
  ProjectWideSettings,
  ProjectLaneView,
  LaneLastChangeResult,
} from "@/lib/sync/project-settings"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import { activeLanes, archivedRegisteredLanes } from "@/components/project-lane-archive"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"

const MAX_LANE_LENGTH = 64

export interface LanguagesSectionProps {
  /** The project's primary target language — read-only here, edited on the
   *  "Project Info" section. Also the first entry in a complete `targetLanes`. */
  defaultTargetLanguage: string
  /** Registered target lanes (includes archived tags — split locally via
   *  project-lane-archive). After AQU-1240 this is the complete registry. */
  targetLanes: string[]
  /** AQU-601: subset of `targetLanes` that is archived (hidden by default). */
  archivedLanes?: string[]
  /** Whether the caller is authorized to write shared settings (mirrors the
   *  server's MAINTAINER 600 floor for the settings PATCH). */
  canEdit: boolean
  /** Human-readable reason write controls are disabled (offline / role), or
   *  null when `canEdit` is true. Mirrors `sharedDisabledTooltip` in
   *  ProjectSettings.tsx — a string or the compact PermissionLockHint. */
  disabledTooltip: ReactNode
  /** The shared-settings patch function (ProjectSettings.tsx's `patchShared`,
   *  i.e. `useProjectSettings(...).patch`). Optimistic-conflict / role /
   *  offline handling all live in that hook already — this component only
   *  has to react to the returned outcome. */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
  /** Lane rows from settings. When present, this section edits those rows. */
  laneRecords?: ProjectLaneView[]
  onRenameLane?: (laneId: string, name: string) => Promise<"ok" | "duplicate" | "invalid">
  onCreateLane?: (input: { name: string; language: string }) => Promise<"ok" | "duplicate" | "invalid">
  onSetLaneArchived?: (laneId: string, archived: boolean) => Promise<boolean>
  /** AQU-1464: reads the lane's newest target edit for the archive confirmation.
   *  Optional — omitted for a local project, where there is no server to ask;
   *  the dialog then simply carries no activity line. */
  onLoadLaneLastChange?: (laneId: string) => Promise<LaneLastChangeResult>
}

function normalizeLane(lane: string): string {
  return lane.trim()
}

function validateNewLane(
  candidate: string,
  existingLanes: string[],
  t: TFunction,
): string | null {
  const trimmed = normalizeLane(candidate)
  if (!trimmed) return t("projectSettings.create.extraLanguagesEmptyError")
  if (trimmed.length > MAX_LANE_LENGTH) {
    return t("projectSettings.create.extraLanguagesTooLongError", { max: MAX_LANE_LENGTH })
  }
  const lower = trimmed.toLowerCase()
  // AQU-1240: the primary target language legitimately lives in targetLanes.
  // Re-adding it is a duplicate of an existing lane, not a special "already
  // the default" error. Blank / over-long / other-lane dupes still reject.
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
  laneRecords,
  onRenameLane,
  onCreateLane,
  onSetLaneArchived,
  onLoadLaneLastChange,
}: LanguagesSectionProps) {
  const t = useT()
  const [newLane, setNewLane] = useState("")
  const [laneName, setLaneName] = useState("")
  const [nameEdited, setNameEdited] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingArchive, setPendingArchive] = useState<string | null>(null)
  const [laneActionError, setLaneActionError] = useState<string | null>(null)
  const [busyLane, setBusyLane] = useState<string | null>(null)

  const targetRows = (laneRecords ?? []).filter((lane) => lane.role === "target")
  const rowMode = targetRows.length > 0 && !!onCreateLane && !!onRenameLane && !!onSetLaneArchived
  const defaultRow = targetRows.find((lane) => (lane.legacyTag ?? "") === "")
  // The former default lane is listed in its own block above (it is still the
  // project's default-language row until AQU-1594 moves language editing onto
  // the lane), so it is kept out of the "additional lanes" list — but it is no
  // longer kept out of ARCHIVING — it carries its own archive control.
  const activeRows = targetRows
    .filter((lane) => (lane.legacyTag ?? "") !== "" && !lane.archivedAt)
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const archivedRows = targetRows
    .filter((lane) => lane.archivedAt)
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  // AQU-1600: every target lane archives, the former default one included.
  // The single remaining rule is that a project keeps at least one active
  // target lane — the server refuses the last one (`last_lane`), so the
  // control is disabled here rather than offering a click that cannot work.
  const activeTargetCount = targetRows.filter((lane) => !lane.archivedAt).length
  const canArchiveAnyLane = activeTargetCount > 1
  const archiveBlockedTooltip = t("projectSettings.languages.lastActiveLaneTooltip")

  // The primary is shown in the default-language field above. Listing it again
  // from the complete registry made a new project's first language appear twice.
  const registryExtras = extraRegistryLanes(targetLanes, defaultTargetLanguage)
  const active = activeLanes(registryExtras, archivedLanes)
  const archived = archivedRegisteredLanes(registryExtras, archivedLanes)

  // AQU-988 / AQU-1240: suggestions skip the primary and every registered
  // lane (active or archived) so the dropdown never offers a pointless
  // re-add. The primary is excluded from *suggestions only* — typing it is
  // not an error unless it is already in targetLanes.
  const excludeFromSuggestions = [defaultTargetLanguage, ...targetLanes]

  // `candidate` lets the Enter-on-a-suggestion path (AQU-1116) add the match
  // straight away — `setNewLane` has not landed in state yet at that point.
  async function handleAdd(candidate: string = newLane) {
    if (!canEdit) return
    // A lane you can translate in is a lane row. The settings tag list alone
    // is not enough: a commit to a tag with no row is refused. Create the row
    // even when this project has none yet (the first extra lane).
    if (onCreateLane) {
      const language = normalizeLane(candidate)
      const name = (nameEdited ? normalizeLane(laneName) : language) || language
      if (!name) {
        setAddError(t("projectSettings.create.extraLanguagesEmptyError"))
        return
      }
      setAddError(null)
      setAdding(true)
      try {
        const result = await onCreateLane({ name, language: language || name })
        if (result === "duplicate") {
          setAddError(t("projectSettings.languages.duplicateNameError"))
          return
        }
        if (result === "invalid") {
          setAddError(t("projectSettings.languages.nameTooLongError"))
          return
        }
        setNewLane("")
        setLaneName("")
        setNameEdited(false)
      } finally {
        setAdding(false)
      }
      return
    }
    const trimmed = normalizeLane(candidate)
    // Dedupe against every registered lane (active + archived) so a tag can't
    // be re-added while an archived copy still holds its cell data.
    const validationError = validateNewLane(trimmed, targetLanes, t)
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
      if (rowMode && onSetLaneArchived) {
        const ok = await onSetLaneArchived(lane, true)
        if (!ok) setLaneActionError(t("projectSettings.languages.savingFailedGeneric"))
        else setPendingArchive(null)
        return
      }
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
      if (rowMode && onSetLaneArchived) {
        const ok = await onSetLaneArchived(lane, false)
        if (!ok) setLaneActionError(t("projectSettings.languages.savingFailedGeneric"))
        return
      }
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
          {rowMode && defaultRow && onRenameLane && (
            <div className="mt-2 max-w-sm">
              <FieldLabel htmlFor={`lane-name-${defaultRow.id}`}>
                {t("projectSettings.languages.laneNameLabel")}
              </FieldLabel>
              <LaneNameField
                laneId={defaultRow.id}
                name={defaultRow.name}
                canEdit={canEdit}
                onRename={onRenameLane}
              />
            </div>
          )}
          {/* AQU-1600: the former default lane is ordinary — it archives from
              here like any extra lane does from the list below, and reappears
              with a Restore control in the archived list. Only the
              last-active-lane rule still refuses. */}
          {rowMode && defaultRow && !defaultRow.archivedAt && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {pendingArchive === defaultRow.id ? (
                <>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {t("projectSettings.languages.archiveConfirm", { lane: defaultRow.name })}
                    </span>
                    {onLoadLaneLastChange && (
                      <LaneLastChangeNote laneId={defaultRow.id} load={onLoadLaneLastChange} />
                    )}
                  </div>
                  <Button
                    variant="destructive"
                    disabled={busyLane === defaultRow.id}
                    onClick={() => void handleConfirmArchive(defaultRow.id)}
                  >
                    {busyLane === defaultRow.id
                      ? t("projectSettings.languages.archivingButton")
                      : t("projectSettings.languages.confirmArchiveButton")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busyLane === defaultRow.id}
                    onClick={() => setPendingArchive(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </>
              ) : (
                <DisabledFieldTooltip
                  disabled={!canEdit || !canArchiveAnyLane}
                  tooltip={canEdit ? archiveBlockedTooltip : disabledTooltip}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    disabled={!canEdit || !canArchiveAnyLane}
                    data-testid={`archive-lane-${defaultRow.id}`}
                    aria-label={t("projectSettings.languages.archiveLaneAriaLabel", {
                      lane: defaultRow.name,
                    })}
                    onClick={() => {
                      setLaneActionError(null)
                      setPendingArchive(defaultRow.id)
                    }}
                  >
                    <Archive className="h-4 w-4" />
                  </Button>
                </DisabledFieldTooltip>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.languages.defaultTargetNote")}
          </p>
        </div>

        <div>
          <FieldLabel>{t("projectSettings.languages.additionalLanesLabel")}</FieldLabel>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("projectSettings.languages.additionalLanesDescription")}
          </p>
          {rowMode ? (
            activeRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("projectSettings.languages.noAdditionalLanes")}</p>
            ) : (
              <ul data-testid="target-lanes-list" className="flex flex-col gap-1">
                {activeRows.map((lane) => (
                  <li
                    key={lane.id}
                    className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-sm"
                  >
                    <LaneNameField
                      laneId={lane.id}
                      name={lane.name}
                      canEdit={canEdit}
                      onRename={onRenameLane!}
                    />
                    {lane.langCode && (
                      <span className="shrink-0 text-xs text-muted-foreground">{lane.langCode}</span>
                    )}
                    {pendingArchive === lane.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-xs text-muted-foreground">
                            {t("projectSettings.languages.archiveConfirm", { lane: lane.name })}
                          </span>
                          {/* AQU-1464: whether the lane is dormant or someone is
                              working in it right now — archiving locks them out. */}
                          {onLoadLaneLastChange && (
                            <LaneLastChangeNote laneId={lane.id} load={onLoadLaneLastChange} />
                          )}
                        </div>
                        <Button
                          variant="destructive"
                          disabled={busyLane === lane.id}
                          onClick={() => void handleConfirmArchive(lane.id)}
                        >
                          {busyLane === lane.id ? t("projectSettings.languages.archivingButton") : t("projectSettings.languages.confirmArchiveButton")}
                        </Button>
                        <Button variant="ghost" disabled={busyLane === lane.id} onClick={() => setPendingArchive(null)}>
                          {t("common.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <DisabledFieldTooltip
                        disabled={!canEdit || !canArchiveAnyLane}
                        tooltip={canEdit ? archiveBlockedTooltip : disabledTooltip}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          disabled={!canEdit || !canArchiveAnyLane}
                          data-testid={`archive-lane-${lane.id}`}
                          aria-label={t("projectSettings.languages.archiveLaneAriaLabel", { lane: lane.name })}
                          onClick={() => {
                            setLaneActionError(null)
                            setPendingArchive(lane.id)
                          }}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      </DisabledFieldTooltip>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.languages.noAdditionalLanes")}</p>
          ) : (
            <ul data-testid="target-lanes-list" className="flex flex-col gap-1">
              {active.map((lane) => (
                <li
                  key={lane}
                  className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-sm"
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
                        disabled={busyLane === lane}
                        onClick={() => void handleConfirmArchive(lane)}
                      >
                        {busyLane === lane ? t("projectSettings.languages.archivingButton") : t("projectSettings.languages.confirmArchiveButton")}
                      </Button>
                      <Button
                        variant="ghost"
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

        {laneActionError && <p className="text-xs text-destructive">{laneActionError}</p>}

        {(rowMode ? archivedRows.length > 0 : archived.length > 0) && (
          <div>
            <FieldLabel>{t("projectSettings.languages.archivedLanesLabel")}</FieldLabel>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("projectSettings.languages.archivedLanesDescription")}
            </p>
            <ul data-testid="archived-lanes-list" className="flex flex-col gap-1">
              {(rowMode ? archivedRows.map((lane) => lane.name) : archived).map((lane, index) => {
                const key = rowMode ? archivedRows[index].id : lane
                return (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded border border-dashed bg-muted/40 px-2 py-1.5 text-sm"
                >
                  <Badge variant="secondary" className="shrink-0 text-muted-foreground">
                    {lane}
                  </Badge>
                  <span className="flex-1" />
                  <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                    <Button
                      variant="ghost"
                      className="h-7 shrink-0 gap-1"
                      disabled={!canEdit || busyLane === key}
                      data-testid={`restore-lane-${key}`}
                      aria-label={t("projectSettings.languages.restoreLaneAriaLabel", { lane })}
                      onClick={() => void handleRestore(key)}
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      {busyLane === key ? t("projectSettings.languages.restoringButton") : t("common.restore")}
                    </Button>
                  </DisabledFieldTooltip>
                </li>
                )
              })}
            </ul>
          </div>
        )}

        <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <FieldLabel htmlFor="add-target-lang">{t("projectSettings.languages.addLaneLabel")}</FieldLabel>
              <LanguageComboboxInput
                id="add-target-lang"
                data-testid="add-target-lang-input"
                value={newLane}
                // Suggestions skip lanes that already exist, so the list can
                // never offer a value the duplicate check would then reject.
                exclude={rowMode ? [] : excludeFromSuggestions}
                onValueChange={(next) => {
                  setNewLane(next)
                  if (rowMode && !nameEdited) setLaneName(next)
                  setAddError(null)
                }}
                // AQU-1116: Enter on the highlighted match adds that lane, the
                // same as Enter on free text adds what was typed. Clicking a
                // row still only fills the field.
                onEnterSelect={(name) => {
                  setNewLane(name)
                  setAddError(null)
                  void handleAdd(name)
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
            {rowMode && (
              <div className="flex-1">
                <FieldLabel htmlFor="add-lane-name">{t("projectSettings.languages.laneNameLabel")}</FieldLabel>
                <input
                  id="add-lane-name"
                  data-testid="add-lane-name-input"
                  value={laneName}
                  placeholder={t("projectSettings.languages.laneNamePlaceholder")}
                  disabled={!canEdit || adding}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  onChange={(e) => {
                    setLaneName(e.target.value)
                    setNameEdited(true)
                    setAddError(null)
                  }}
                />
              </div>
            )}
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
      </CardContent>
    </Card>
  )
}

function LaneNameField({
  laneId,
  name,
  canEdit,
  onRename,
}: {
  laneId: string
  name: string
  canEdit: boolean
  onRename: (laneId: string, name: string) => Promise<"ok" | "duplicate" | "invalid">
}) {
  const t = useT()
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(name)
  }, [name])

  async function commit() {
    const next = draft.trim()
    if (!next || next === name.trim()) return
    const result = await onRename(laneId, next)
    if (result === "ok") {
      setError(null)
      return
    }
    setError(
      result === "duplicate"
        ? t("projectSettings.languages.duplicateNameError")
        : t("projectSettings.languages.nameTooLongError"),
    )
  }

  return (
    <div className="min-w-0 flex-1">
      <input
        value={draft}
        disabled={!canEdit}
        aria-label={t("projectSettings.languages.laneNameLabel")}
        className="w-full rounded border bg-background px-2 py-1 text-sm"
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        onBlur={() => {
          void commit()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            void commit()
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * AQU-1464 — the "is anyone still working in this lane?" line inside the archive
 * confirmation. Mounts with the confirmation and unmounts on cancel, so the
 * lookup runs once per dialog open; race-guarded per AD-3 (plain useState +
 * cancelled flag, no React Query).
 *
 * This never gates archiving: loading, unknown and failed are all just a line of
 * text, and the Confirm button beside it is untouched. A FAILED lookup says so
 * rather than falling back to "no changes in this lane yet" — a PM would read
 * that as "dormant, safe to archive", which is precisely the wrong conclusion to
 * draw from a request that never answered.
 */
function LaneLastChangeNote({
  laneId,
  load,
}: {
  laneId: string
  load: (laneId: string) => Promise<LaneLastChangeResult>
}) {
  const t = useT()
  // `isolate` wraps the date and the username in bidi isolates: both are
  // Latin/numeric tokens sitting inside prose, so in Arabic the bidi algorithm
  // would otherwise reorder them against the surrounding sentence (see the
  // module note in lib/i18n/format.ts).
  const { date, isolate } = useFormat()
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ok"; at: number | null; by: string | null }
  >({ kind: "loading" })

  // No synchronous "reset to loading" here: the component mounts fresh with each
  // confirmation, so the initial state already IS loading. On the rare re-run
  // (the bound fetcher's identity changes when the session or project does) the
  // previous answer stays on screen until the new one lands, which is steadier
  // than flashing back to "checking…" — and the cancelled flag still makes the
  // newest run the one that wins.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let result: LaneLastChangeResult
      try {
        result = await load(laneId)
      } catch (e) {
        result = { kind: "error", message: e instanceof Error ? e.message : String(e) }
      }
      if (cancelled) return
      if (result.kind !== "ok") {
        setState({ kind: "error" })
        return
      }
      setState({
        kind: "ok",
        at: result.lastChange?.at ?? null,
        by: result.lastChange?.by ?? null,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [laneId, load])

  let text: string
  if (state.kind === "loading") {
    text = t("projectSettings.languages.lastChangeLoading")
  } else if (state.kind === "error") {
    text = t("projectSettings.languages.lastChangeUnavailable")
  } else if (state.at === null) {
    text = t("projectSettings.languages.lastChangeNone")
  } else if (state.by) {
    text = t("projectSettings.languages.lastChange", {
      date: isolate(date(state.at)),
      editor: isolate(state.by),
    })
  } else {
    text = t("projectSettings.languages.lastChangeUnknownEditor", {
      date: isolate(date(state.at)),
    })
  }

  return (
    <span
      data-testid={`lane-last-change-${laneId}`}
      className="text-xs text-muted-foreground"
    >
      {text}
    </span>
  )
}
