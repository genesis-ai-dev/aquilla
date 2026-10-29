// LanguagesSection — AQU-538 slice 2 "project settings UI: manage target lanes",
// AQU-1240 slice 1: `settings.targetLanes` is the COMPLETE lane registry
// (primary included). AQU-1796: every target lane, including the former
// default (`legacy_tag` ''), is one list. The source language stays on the
// source lane, above that list.
//
// Media redesign (Sam, Oct 25, design B "compact table"): the source is one
// line with Change; the targets are a table — Language | Name | Code |
// Delivers | ⋯ — whose rows open into labelled fields with Save and Cancel.
// Explanations and long sub-text sit behind (i) icons, and nothing is drawn as
// a pill.
//
// AQU-2174: the LANGUAGE leads everywhere on this card — the table's first
// column, the edit form's first field, and the one-line summaries (source and
// archived) — because it is the required field, the one the AI is told, and the
// one the add form already asks for first. The name is an optional display
// override that falls back to the language, so it follows it. The row menu
// offers one `Edit` item: "Rename" and "Language and code…" opened the same
// form and differed only in which field took focus.
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
import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Globe,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  TriangleAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { LanguageComboboxInput } from "@/components/LanguageComboboxInput"
import { FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { LockedNote, LockedSection } from "@/components/ui/locked-note"
import type {
  ProjectWideSettings,
  ProjectLaneView,
  LaneLastChangeResult,
} from "@/lib/sync/project-settings"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import { activeLanes, archivedRegisteredLanes } from "@/components/project-lane-archive"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import {
  laneDisplayName,
  laneLanguage,
  laneLanguageCode,
} from "@/lib/lanes/lane-display"
import { useDerivedLanguageCode } from "@/lib/languages/use-derived-language-code"
import { laneLabelSuffixesById } from "@/lib/lanes/lane-language"
import { withLaneLabelSuffix } from "@/lib/lanes/lane-label-suffix"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { LaneDeliversSelect } from "@/components/LaneDeliversSelect"
import { laneRowDelivers, type LaneDelivers } from "@/lib/lanes/lane-delivers"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"

const MAX_LANE_LENGTH = 64

// The table's columns: Language | Name | Code | Delivers | ⋯ (AQU-2174). Below
// `sm` the Name and Code columns fold into a muted line under the language, so
// a phone keeps the language, the Delivers choice and the menu side by side.
const GRID_WITH_DELIVERS =
  "grid grid-cols-[minmax(0,1fr)_9.5rem_2rem] sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_4.5rem_10rem_2rem] items-center gap-x-3"
const GRID_WITHOUT_DELIVERS =
  "grid grid-cols-[minmax(0,1fr)_2rem] sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_4.5rem_2rem] items-center gap-x-3"

const FIELD_INPUT_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm"

export interface LanguagesSectionProps {
  /** The project's primary target language — read-only here, edited on the
   *  "Project Info" section. Also the first entry in a complete `targetLanes`. */
  defaultTargetLanguage: string
  /** Registered target lanes (includes archived tags — split locally via
   *  project-lane-archive). After AQU-1240 this is the complete registry. */
  targetLanes: string[]
  /** AQU-601: subset of `targetLanes` that is archived (hidden by default). */
  archivedLanes?: string[]
  /** Whether the caller may change this card: the org's language-edit floor
   *  (`canEditLanguages`), and online. One floor gates every control here. */
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
  /**
   * AQU-1592: edit a lane's identity. `name`/`code` are nullable overrides —
   * null or "" clears them so the lane falls back to showing its language and
   * to a derived code. Omit a field to leave it as it is.
   */
  onRenameLane?: (
    laneId: string,
    edit: { name?: string | null; language?: string; code?: string | null },
  ) => Promise<"ok" | "duplicate" | "invalid" | "malformed_code">
  onCreateLane?: (input: {
    name: string
    language: string
    code?: string | null
    /** AQU-1784: accept a display name that duplicates an ACTIVE lane's. Sent
     *  once this section has shown the collision inline, so the maintainer has
     *  already seen it. A name duplicating an ARCHIVED lane is still refused —
     *  restoring that lane is what they want. */
    allowDuplicateName?: boolean
    /** Media redesign: what the new language delivers, chosen in the add form.
     *  Sent only where the rows show Delivers. */
    delivers?: LaneDelivers
  }) => Promise<"ok" | "duplicate" | "invalid" | "malformed_code">
  onSetLaneArchived?: (laneId: string, archived: boolean) => Promise<boolean>
  /**
   * Media redesign slice 1: the "Delivers" choice on each language row (Text,
   * Audio, or Text and audio), which replaced AQU-1954's "Records audio"
   * switch. Omitted (a local project, or an older caller), the rows show none.
   */
  onSetLaneDelivers?: (laneId: string, delivers: LaneDelivers) => Promise<LaneDeliversOutcome>
  /** AQU-1464: reads the lane's newest target edit for the archive confirmation.
   *  Optional — omitted for a local project, where there is no server to ask;
   *  the dialog then simply carries no activity line. */
  onLoadLaneLastChange?: (laneId: string) => Promise<LaneLastChangeResult>
  /** AQU-2031: the editor's "Add lane…" deep link (`?focus=add-lane`) lands
   *  with the add form already open. */
  startAdding?: boolean
}

/** How saving a language's "Delivers" choice went. */
export type LaneDeliversOutcome = "ok" | "forbidden" | "offline" | "error"

type LaneIdentityEdit = { name?: string | null; language?: string; code?: string | null }
type LaneEditResult = "ok" | "duplicate" | "invalid" | "malformed_code"

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

function editResultMessage(result: Exclude<LaneEditResult, "ok">, t: TFunction): string {
  if (result === "duplicate") return t("projectSettings.languages.duplicateNameError")
  if (result === "malformed_code") return t("projectSettings.languages.laneCodeMalformedError")
  return t("projectSettings.languages.nameTooLongError")
}

/** Registry order: the order the lane switcher numbers a collision in. */
function byPosition(a: ProjectLaneView, b: ProjectLaneView): number {
  return a.position - b.position || a.id.localeCompare(b.id)
}

/**
 * AQU-2174 — what follows the language in a one-line summary of a lane: the
 * lane's label when it says something the language does not, then the code. A
 * lane whose name is just its language therefore reads "Samoan · sm", not
 * "Samoan · Samoan · sm".
 */
function summaryDetail(lane: ProjectLaneView, label: string): string {
  const language = laneLanguage(lane)
  return [label !== language ? label : null, laneLanguageCode(lane)]
    .filter(Boolean)
    .join(" · ")
}

function foldedDisplayName(lane: Pick<ProjectLaneView, "role" | "language" | "name">): string {
  return laneDisplayName(lane).trim().toLocaleLowerCase()
}

/**
 * The card's (i): explanatory or long text, on hover or keyboard focus, so the
 * card itself stays short (Sam, Oct 25). Same shape as ProjectCreateDialog's
 * LanguageFieldHint; a rich node (the permission hint with its link) gets the
 * column layout DisabledFieldTooltip gives it.
 */
function InfoHint({
  label,
  children,
  testId,
  warning = false,
}: {
  /** The button's accessible name: a few words saying what the text is about. */
  label: string
  children: ReactNode
  testId?: string
  warning?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            className={cn(
              "inline-flex shrink-0 text-muted-foreground hover:text-foreground",
              warning && "text-amber-700 hover:text-amber-800 dark:text-amber-500 dark:hover:text-amber-400",
            )}
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent
        className={cn(
          "max-w-xs",
          typeof children !== "string" && "inline-flex max-w-64 flex-col items-start gap-1 pt-2",
        )}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  )
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
  onSetLaneDelivers,
  onLoadLaneLastChange,
  startAdding = false,
}: LanguagesSectionProps) {
  const t = useT()
  const [addOpen, setAddOpen] = useState(startAdding)
  const [newLane, setNewLane] = useState("")
  const [laneName, setLaneName] = useState("")
  const [nameEdited, setNameEdited] = useState(false)
  const [laneCode, setLaneCode] = useState("")
  const [newDelivers, setNewDelivers] = useState<LaneDelivers>("text")
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // The one row opened into its fields (a target row or the source), and the
  // field that takes focus: the menu's Edit and the source's Change land on
  // Language (the form's first field); clicking a name, and the "two languages
  // share a name" warning's Rename, land on Name, because those are explicitly
  // about the name.
  const [editing, setEditing] = useState<{ laneId: string; focus: "name" | "language" } | null>(null)
  const [pendingArchive, setPendingArchive] = useState<string | null>(null)
  const [laneActionError, setLaneActionError] = useState<string | null>(null)
  const [busyLane, setBusyLane] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  // The row whose "Delivers" choice is saving, and the value it is saving: the
  // dropdown shows it at once and snaps back to the stored one if refused.
  const [deliversSaving, setDeliversSaving] = useState<{ laneId: string; delivers: LaneDelivers } | null>(null)
  const derivedNewLaneCode = useDerivedLanguageCode(newLane)

  const laneRows = laneRecords ?? []
  const targetRows = laneRows.filter((lane) => lane.role === "target")
  const sourceRow = laneRows.find((lane) => lane.role === "source")
  // A new project has a source lane and no target row. Row mode is on as soon
  // as any lane row exists and the lane callbacks are wired, so the first
  // target is created with onCreateLane. The settings-blob path stays only
  // for a project that has no lane rows at all (pre-backfill).
  const rowMode =
    laneRows.length > 0 && !!onCreateLane && !!onRenameLane && !!onSetLaneArchived
  const showDelivers = rowMode && !!onSetLaneDelivers
  const grid = showDelivers ? GRID_WITH_DELIVERS : GRID_WITHOUT_DELIVERS
  // AQU-1796: the former default target (legacy_tag '') is a target lane.
  // It is listed with the others, not under its own heading.
  const activeRows = targetRows.filter((lane) => !lane.archivedAt).sort(byPosition)
  const archivedRows = targetRows.filter((lane) => lane.archivedAt).sort(byPosition)
  // AQU-1600: every target lane archives, the former default one included.
  // The single remaining rule is that a project keeps at least one active
  // target lane — the server refuses the last one (`last_lane`), so the
  // control is disabled here rather than offering a click that cannot work.
  const canArchiveAnyLane = activeRows.length > 1
  // AQU-1784: two lanes can resolve to the same display string — the same
  // language with no name override on either, or the same name typed twice.
  // They are told apart by a suffix, numbered in REGISTRY order so this screen
  // and the editor's lane switcher name a collision identically.
  const laneSuffixes = laneLabelSuffixesById(targetRows.slice().sort(byPosition))
  const laneLabel = (lane: ProjectLaneView) =>
    withLaneLabelSuffix(laneDisplayName(lane), laneSuffixes[lane.id] ?? null)
  // Active languages that share a name, in registry order. Each group gets the
  // warning above the table, whose actions act on its second language.
  const byFoldedName = new Map<string, ProjectLaneView[]>()
  for (const lane of activeRows) {
    const key = foldedDisplayName(lane)
    byFoldedName.set(key, [...(byFoldedName.get(key) ?? []), lane])
  }
  const sameNameGroups = [...byFoldedName.values()].filter((group) => group.length > 1)
  const sameNameIds = new Set(sameNameGroups.flat().map((lane) => lane.id))
  /**
   * The ACTIVE lane a new one would read the same as, or undefined. Two lanes
   * of one language is a legitimate shape (two teams, one language), so this
   * drives a notice rather than a refusal — and the same answer tells
   * `handleAdd` to send `allowDuplicateName`.
   */
  function duplicateActiveLane(language: string, name: string): ProjectLaneView | undefined {
    // A blank candidate has no display name of its own — the placeholder
    // `laneDisplayName` would hand back must not collide with anything.
    if (!language && !name) return undefined
    const folded = foldedDisplayName({ role: "target", language, name: name || null })
    return activeRows.find((lane) => foldedDisplayName(lane) === folded)
  }
  const pendingDuplicate = rowMode
    ? duplicateActiveLane(
        normalizeLane(newLane),
        nameEdited ? normalizeLane(laneName) : "",
      )
    : undefined
  const archiveBlockedTooltip = t("projectSettings.languages.lastActiveLaneTooltip")

  // Blob-mode projects have no lane rows. The primary language used to sit in
  // its own "Default target language" field and was left out of the extras
  // list so it would not appear twice (AQU-1473). It now leads the one target
  // list. `extraRegistryLanes` still drops it from `active`, so prepending it
  // does not duplicate a new project's first language.
  const registryExtras = extraRegistryLanes(targetLanes, defaultTargetLanguage)
  const active = activeLanes(registryExtras, archivedLanes)
  const archived = archivedRegisteredLanes(registryExtras, archivedLanes)
  const primaryLane = defaultTargetLanguage.trim()
  const blobActive = primaryLane
    ? [primaryLane, ...active.filter((lane) => lane !== primaryLane)]
    : active

  // AQU-988 / AQU-1240: suggestions skip the primary and every registered
  // lane (active or archived) so the dropdown never offers a pointless
  // re-add. The primary is excluded from *suggestions only* — typing it is
  // not an error unless it is already in targetLanes.
  const excludeFromSuggestions = [defaultTargetLanguage, ...targetLanes]

  function resetAddForm() {
    setNewLane("")
    setLaneName("")
    setNameEdited(false)
    setLaneCode("")
    setNewDelivers("text")
    setAddError(null)
  }

  function closeAddForm() {
    resetAddForm()
    setAddOpen(false)
  }

  function startEdit(laneId: string, focus: "name" | "language") {
    if (!canEdit) return
    setLaneActionError(null)
    setPendingArchive(null)
    setEditing({ laneId, focus })
  }

  function askArchive(lane: string) {
    if (!canEdit) return
    setLaneActionError(null)
    setEditing(null)
    setPendingArchive(lane)
  }

  // `candidate` lets the Enter-on-a-suggestion path (AQU-1116) add the match
  // straight away — `setNewLane` has not landed in state yet at that point.
  async function handleAdd(candidate: string = newLane) {
    if (!canEdit) return
    // A lane you can translate in is a lane row. The settings tag list alone
    // is not enough: a commit to a tag with no row is refused. Create the row
    // even when this project has none yet (the first extra lane).
    if (onCreateLane) {
      const language = normalizeLane(candidate)
      // AQU-1592: the LANGUAGE is the required field. The name is optional and
      // is submitted only when the user typed one — never derived from the
      // language, which is what the lane falls back to showing anyway.
      if (!language) {
        setAddError(t("projectSettings.languages.laneLanguageRequiredError"))
        return
      }
      const name = nameEdited ? normalizeLane(laneName) : ""
      setAddError(null)
      setAdding(true)
      try {
        const result = await onCreateLane({
          name,
          language,
          code: normalizeLane(laneCode) || null,
          // The collision has been on screen as a notice while they typed, so
          // the save goes through rather than coming back refused.
          allowDuplicateName: !!duplicateActiveLane(language, name),
          ...(showDelivers ? { delivers: newDelivers } : {}),
        })
        if (result !== "ok") {
          setAddError(editResultMessage(result, t))
          return
        }
        closeAddForm()
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
      closeAddForm()
    } finally {
      setAdding(false)
    }
  }

  async function handleDelivers(laneId: string, delivers: LaneDelivers) {
    if (!onSetLaneDelivers || !canEdit) return
    setLaneActionError(null)
    setDeliversSaving({ laneId, delivers })
    try {
      const outcome = await onSetLaneDelivers(laneId, delivers)
      if (outcome === "forbidden") setLaneActionError(t("projectSettings.languages.permissionError"))
      else if (outcome === "offline") setLaneActionError(t("projectSettings.languages.offlineError"))
      else if (outcome === "error") setLaneActionError(t("projectSettings.languages.savingFailedGeneric"))
    } finally {
      setDeliversSaving(null)
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

  /** The ⋯ menu: Edit, Archive (AQU-2174). Blob lanes only archive. */
  function rowMenu(key: string, label: string) {
    return (
      <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid={`lane-menu-${key}`}
            aria-label={t("projectSettings.languages.rowMenuAriaLabel", { lane: label })}
            disabled={!canEdit}
            className="text-muted-foreground hover:text-foreground"
            render={<Button type="button" size="icon-sm" variant="ghost" />}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            {rowMode && (
              <DropdownMenuItem
                data-testid={`lane-edit-action-${key}`}
                onClick={() => startEdit(key, "language")}
              >
                <Pencil className="size-4" />
                {t("common.edit")}
              </DropdownMenuItem>
            )}
            <DisabledFieldTooltip
              disabled={rowMode && !canArchiveAnyLane}
              tooltip={archiveBlockedTooltip}
              align="start"
              noteClassName="px-2 pb-1.5"
            >
              <DropdownMenuItem
                data-testid={`archive-lane-${key}`}
                disabled={rowMode && !canArchiveAnyLane}
                aria-label={t("projectSettings.languages.archiveLaneAriaLabel", { lane: label })}
                onClick={() => askArchive(key)}
              >
                <Archive className="size-4" />
                {t("org.projectOverview.archive")}
              </DropdownMenuItem>
            </DisabledFieldTooltip>
          </DropdownMenuContent>
        </DropdownMenu>
      </DisabledFieldTooltip>
    )
  }

  /** The row under a language that asks before archiving it. */
  function archiveConfirmRow(key: string, label: string) {
    return (
      <div role="row" className="border-b bg-muted/30 px-3 py-2 last:border-b-0">
        <div
          role="cell"
          className="flex w-full flex-wrap items-center gap-2"
          data-testid={`archive-confirm-${key}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm">
              {t("projectSettings.languages.archiveConfirmShort", { lane: label })}
              <InfoHint label={t("projectSettings.languages.archiveHintAriaLabel")}>
                {t("projectSettings.languages.archiveHint")}
              </InfoHint>
            </span>
            {/* AQU-1464: whether the lane is dormant or someone is working in
                it right now — archiving locks them out. */}
            {rowMode && onLoadLaneLastChange && (
              <LaneLastChangeNote laneId={key} load={onLoadLaneLastChange} />
            )}
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={busyLane === key}
            onClick={() => void handleConfirmArchive(key)}
          >
            {busyLane === key
              ? t("projectSettings.languages.archivingButton")
              : t("projectSettings.languages.confirmArchiveButton")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busyLane === key} onClick={() => setPendingArchive(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    )
  }

  const tableHeader = (
    <div
      role="row"
      className={cn(grid, "border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground")}
    >
      <span role="columnheader">{t("org.orgHome.table.languageHeader")}</span>
      <span role="columnheader" className="hidden sm:block">
        {t("common.name")}
      </span>
      <span role="columnheader" className="hidden sm:block">
        {t("projectSettings.languages.codeColumn")}
      </span>
      {showDelivers && (
        <span role="columnheader" className="flex items-center gap-1">
          {t("projectSettings.languages.deliversLabel")}
          {/* Media redesign slice 1 (Sam, Oct 22): what a language delivers
              decides how its progress is counted everywhere. */}
          <InfoHint
            label={t("projectSettings.languages.deliversHintAriaLabel")}
            testId="lane-delivers-hint"
          >
            {t("projectSettings.languages.deliversHint")}
          </InfoHint>
        </span>
      )}
      <span role="columnheader">
        <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>
      </span>
    </div>
  )

  const noTargets = rowMode ? activeRows.length === 0 : blobActive.length === 0
  const archivedCount = rowMode ? archivedRows.length : archived.length

  return (
    <Card id="section-languages">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.section.languages")}
        </CardTitle>
        {/* AQU-2260: below the language-edit floor (or offline) every control
            here is disabled; one line under the title says why, once, and the
            controls stay quiet. */}
        {!canEdit && disabledTooltip && (
          <LockedNote placement="section" testId="languages-view-only">
            {disabledTooltip}
          </LockedNote>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <LockedSection reason={canEdit ? null : disabledTooltip}>
        {sourceRow && onRenameLane && (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("projectSettings.info.sourceLanguageLabel")}</span>
            {editing?.laneId === sourceRow.id ? (
              <div className="rounded-md border bg-muted/30 p-3">
                <LaneEditFields
                  lane={sourceRow}
                  focus={editing.focus}
                  onSave={onRenameLane}
                  onDone={() => setEditing(null)}
                />
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2 text-sm" data-testid="source-language-line">
                {laneLanguage(sourceRow) ? (
                  /* AQU-2174: language · name · code, and the name only when it
                     says something the language does not. */
                  <span className="truncate">
                    <span className="font-medium">{laneLanguage(sourceRow)}</span>
                    {laneDisplayName(sourceRow) !== laneLanguage(sourceRow) && (
                      <span className="text-muted-foreground"> · {laneDisplayName(sourceRow)}</span>
                    )}
                    {laneLanguageCode(sourceRow) && (
                      <span className="font-mono text-xs text-muted-foreground"> · {laneLanguageCode(sourceRow)}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("projectSettings.languages.noLanguageSet")}</span>
                )}
                <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0"
                    data-testid="source-language-change"
                    aria-label={t("projectSettings.languages.changeSourceAriaLabel")}
                    disabled={!canEdit}
                    onClick={() => startEdit(sourceRow.id, "language")}
                  >
                    {t("org.projectOverview.change")}
                  </Button>
                </DisabledFieldTooltip>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{t("projectSettings.languages.targetLanguagesHeading")}</span>
            <InfoHint label={t("projectSettings.languages.targetLanguagesHintAriaLabel")}>
              {t("projectSettings.languages.targetLanguagesHint")}
            </InfoHint>
          </div>

          {/* AQU-1784: two languages that read the same are allowed, but the
              pair is hard to tell apart, so it is named here with a way out. */}
          {rowMode &&
            sameNameGroups.map((group) => {
              const second = group[1]
              return (
                <div
                  key={second.id}
                  role="status"
                  data-testid="lane-duplicate-warning"
                  className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden="true" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span>
                      {t(
                        group.length === 2
                          ? "projectSettings.languages.duplicateBannerTwo"
                          : "projectSettings.languages.duplicateBannerMany",
                        { lane: laneDisplayName(second) },
                      )}
                    </span>
                    <div className="flex flex-wrap gap-3">
                      <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto px-0 text-amber-900 dark:text-amber-200"
                          data-testid="lane-duplicate-rename"
                          disabled={!canEdit}
                          onClick={() => startEdit(second.id, "name")}
                        >
                          {t("projectSettings.languages.duplicateRenameAction")}
                        </Button>
                      </DisabledFieldTooltip>
                      <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto px-0 text-amber-900 dark:text-amber-200"
                          data-testid="lane-duplicate-archive"
                          disabled={!canEdit}
                          onClick={() => askArchive(second.id)}
                        >
                          {t("projectSettings.languages.duplicateArchiveAction")}
                        </Button>
                      </DisabledFieldTooltip>
                    </div>
                  </div>
                </div>
              )
            })}

          {noTargets ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.languages.noTargetLanguages")}</p>
          ) : (
            <div
              role="table"
              aria-label={t("projectSettings.languages.targetLanguagesHeading")}
              data-testid="target-lanes-list"
              className="rounded-md border"
            >
              {tableHeader}
              {rowMode
                ? activeRows.map((lane) => {
                    const label = laneLabel(lane)
                    const language = laneLanguage(lane)
                    const code = laneLanguageCode(lane)
                    const delivers = laneRowDelivers(lane)
                    // What the Name and Code columns fold into below `sm`.
                    const folded = summaryDetail(lane, laneDisplayName(lane))
                    if (editing?.laneId === lane.id) {
                      return (
                        <div key={lane.id} role="row" className="border-b bg-muted/30 px-3 py-3 last:border-b-0">
                          <div role="cell">
                            <LaneEditFields
                              lane={lane}
                              focus={editing.focus}
                              onSave={onRenameLane!}
                              onDone={() => setEditing(null)}
                            />
                          </div>
                        </div>
                      )
                    }
                    return (
                      <Fragment key={lane.id}>
                        <div
                          role="row"
                          className={cn(grid, "border-b px-3 py-1.5 text-sm last:border-b-0")}
                          data-testid={`lane-identity-row-${lane.id}`}
                        >
                          {/* AQU-2174: the language is the row's main label, so
                              a phone leads with it too; the name (only when it
                              differs) and the code fold under it. */}
                          <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex min-w-0 items-center gap-1">
                              <span
                                className={cn("min-w-0 truncate font-medium", !language && "text-muted-foreground")}
                                data-testid={`lane-language-cell-${lane.id}`}
                              >
                                {language || t("projectSettings.languages.noLanguageSet")}
                              </span>
                              {/* AQU-1784: a lane that shares its label with
                                  another says how it is told apart elsewhere. */}
                              {laneSuffixes[lane.id] && (
                                <InfoHint
                                  label={t("projectSettings.languages.laneShownAs", { label })}
                                  testId={`lane-shown-as-${lane.id}`}
                                >
                                  {t("projectSettings.languages.laneShownAs", { label })}
                                </InfoHint>
                              )}
                            </span>
                            {sameNameIds.has(lane.id) && (
                              <span
                                className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-500"
                                data-testid={`lane-same-name-${lane.id}`}
                              >
                                <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                                {t("projectSettings.languages.sameNameMarker")}
                              </span>
                            )}
                            {folded && (
                              <span className="truncate text-xs text-muted-foreground sm:hidden">
                                {folded}
                              </span>
                            )}
                          </div>
                          <span role="cell" className="hidden min-w-0 truncate sm:block">
                            {canEdit ? (
                              <button
                                type="button"
                                data-testid={`lane-name-${lane.id}`}
                                aria-label={t("projectSettings.languages.renameLaneAriaLabel", { lane: label })}
                                className="min-w-0 max-w-full truncate text-start underline-offset-2 hover:underline"
                                onClick={() => startEdit(lane.id, "name")}
                              >
                                {laneDisplayName(lane)}
                              </button>
                            ) : (
                              <span className="min-w-0 truncate" data-testid={`lane-name-${lane.id}`}>
                                {laneDisplayName(lane)}
                              </span>
                            )}
                          </span>
                          <span
                            role="cell"
                            className="hidden truncate font-mono text-xs text-muted-foreground sm:block"
                            data-testid={`lane-language-code-${lane.id}`}
                          >
                            {code}
                          </span>
                          {showDelivers && (
                            <div role="cell" className="flex min-w-0 items-center gap-1">
                              <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                                <LaneDeliversSelect
                                  testId={`lane-delivers-${lane.id}`}
                                  value={deliversSaving?.laneId === lane.id ? deliversSaving.delivers : delivers}
                                  laneLabel={label}
                                  disabled={!canEdit || deliversSaving?.laneId === lane.id}
                                  onValueChange={(next) => void handleDelivers(lane.id, next)}
                                />
                              </DisabledFieldTooltip>
                              {/* A language that had "Records audio" on has
                                  no choice yet; the select reads Choose. */}
                              {delivers == null && (
                                <InfoHint
                                  warning
                                  label={t("projectSettings.languages.deliversNeedsChoiceAriaLabel", { lane: label })}
                                  testId={`lane-delivers-needs-choice-${lane.id}`}
                                >
                                  {t("projectSettings.languages.deliversNeedsChoice")}
                                </InfoHint>
                              )}
                            </div>
                          )}
                          <div role="cell" className="flex justify-end">
                            {rowMenu(lane.id, label)}
                          </div>
                        </div>
                        {pendingArchive === lane.id && archiveConfirmRow(lane.id, label)}
                      </Fragment>
                    )
                  })
                : blobActive.map((lane) => (
                    <Fragment key={lane}>
                      <div role="row" className={cn(grid, "border-b px-3 py-1.5 text-sm last:border-b-0")}>
                        <span role="cell" className="min-w-0 truncate font-medium">{lane}</span>
                        <span role="cell" className="hidden sm:block" />
                        <span role="cell" className="hidden sm:block" />
                        {/* The primary is not archivable here (AQU-1473). */}
                        <div role="cell" className="flex justify-end">
                          {active.includes(lane) && rowMenu(lane, lane)}
                        </div>
                      </div>
                      {pendingArchive === lane && archiveConfirmRow(lane, lane)}
                    </Fragment>
                  ))}
            </div>
          )}

          {laneActionError && <p className="text-xs text-destructive">{laneActionError}</p>}
        </div>

        {/* AQU-2031: "Add lane…" in the editor's TARGET header deep-links to
            `…/settings/general?focus=add-lane`, which scrolls this into view
            with the form open. */}
        <div id="add-lane-field">
          {addOpen && canEdit ? (
            <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="add-lane-form">
              <span className="text-sm font-medium">{t("projectSettings.languages.addLanguageHeading")}</span>
              <div className={cn("grid gap-3", rowMode && "sm:grid-cols-2")}>
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="add-target-lang">{t("org.orgHome.table.languageHeader")}</FieldLabel>
                  <LanguageComboboxInput
                    id="add-target-lang"
                    data-testid="add-target-lang-input"
                    autoFocus
                    value={newLane}
                    // Suggestions skip lanes that already exist, so the list can
                    // never offer a value the duplicate check would then reject.
                    exclude={rowMode ? [] : excludeFromSuggestions}
                    onValueChange={(next) => {
                      setNewLane(next)
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
                    disabled={adding}
                  />
                </div>
                {rowMode && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <FieldLabel htmlFor="add-lane-name">{t("common.name")}</FieldLabel>
                      <InfoHint label={t("projectSettings.languages.addNameHintAriaLabel")}>
                        {t("projectSettings.languages.addNameHint")}
                      </InfoHint>
                    </div>
                    <input
                      id="add-lane-name"
                      data-testid="add-lane-name-input"
                      value={laneName}
                      // AQU-1592: the typed language is the placeholder, because
                      // that is what the lane shows when no name is given.
                      placeholder={
                        normalizeLane(newLane) || t("projectSettings.languages.laneNamePlaceholder")
                      }
                      disabled={adding}
                      className={FIELD_INPUT_CLASS}
                      onChange={(e) => {
                        setLaneName(e.target.value)
                        setNameEdited(true)
                        setAddError(null)
                      }}
                    />
                  </div>
                )}
                {/* AQU-1592: blank derives the code from the language at read
                    time; the derived value is never written back. */}
                {rowMode && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <FieldLabel htmlFor="add-lane-code">{t("projectSettings.languages.codeOptionalLabel")}</FieldLabel>
                      <InfoHint label={t("projectSettings.languages.codeHintAriaLabel")}>
                        {t("projectSettings.languages.laneCodeNote")}
                      </InfoHint>
                    </div>
                    <input
                      id="add-lane-code"
                      data-testid="add-lane-code-input"
                      value={laneCode}
                      placeholder={
                        derivedNewLaneCode ?? t("projectSettings.languages.laneCodeDerivedPlaceholder")
                      }
                      disabled={adding}
                      className={cn(FIELD_INPUT_CLASS, "font-mono")}
                      onChange={(e) => {
                        setLaneCode(e.target.value)
                        setAddError(null)
                      }}
                    />
                  </div>
                )}
                {showDelivers && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <FieldLabel htmlFor="add-lane-delivers">{t("projectSettings.languages.deliversLabel")}</FieldLabel>
                      <InfoHint label={t("projectSettings.languages.deliversHintAriaLabel")}>
                        {t("projectSettings.languages.deliversHint")}
                      </InfoHint>
                    </div>
                    <LaneDeliversSelect
                      id="add-lane-delivers"
                      testId="add-lane-delivers"
                      value={newDelivers}
                      laneLabel={
                        normalizeLane(laneName) ||
                        normalizeLane(newLane) ||
                        t("projectSettings.languages.newLanguageLabel")
                      }
                      disabled={adding}
                      className="w-full"
                      onValueChange={setNewDelivers}
                    />
                  </div>
                )}
              </div>
              {/* AQU-1784: the collision is named BEFORE the save, and the save
                  is still allowed — the switcher numbers the pair once both
                  exist. */}
              {pendingDuplicate && !addError && (
                <p className="text-xs text-amber-700 dark:text-amber-500" data-testid="add-lane-duplicate-notice">
                  {t("projectSettings.languages.addDuplicateNotice", {
                    lane: laneLabel(pendingDuplicate),
                  })}
                </p>
              )}
              {addError && <p className="text-xs text-destructive">{addError}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="add-target-lang-btn"
                  onClick={() => void handleAdd()}
                  disabled={adding}
                >
                  {adding ? t("common.adding") : t("org.overviewLaneTable.addLanguageAction")}
                </Button>
                <Button size="sm" variant="ghost" disabled={adding} onClick={closeAddForm}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="add-lane-open"
                disabled={!canEdit}
                onClick={() => {
                  resetAddForm()
                  setAddOpen(true)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("org.overviewLaneTable.addLanguageAction")}
              </Button>
            </DisabledFieldTooltip>
          )}
        </div>

        {archivedCount > 0 && (
          <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
            <div className="flex items-center gap-1.5">
              <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn("size-4 transition-transform", archivedOpen && "rotate-90")}
                  aria-hidden="true"
                />
                <span data-testid="archived-lanes-toggle">
                  {t("org.overviewLaneTable.archivedGroup", { count: archivedCount })}
                </span>
              </CollapsibleTrigger>
              <InfoHint label={t("projectSettings.languages.archivedHintAriaLabel")}>
                {t("projectSettings.languages.archivedHint")}
              </InfoHint>
            </div>
            <CollapsibleContent>
              <ul data-testid="archived-lanes-list" className="mt-2 divide-y rounded-md border">
                {(rowMode
                  ? archivedRows.map((lane) => ({
                      key: lane.id,
                      // AQU-2174: language · name · code, the name only when it
                      // says something the language does not.
                      label: laneLanguage(lane) || t("projectSettings.languages.noLanguageSet"),
                      detail: summaryDetail(lane, laneLabel(lane)),
                    }))
                  : archived.map((lane) => ({ key: lane, label: lane, detail: "" }))
                ).map(({ key, label, detail }) => (
                  <li key={key} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-muted-foreground">{label}</span>
                      {detail && <span className="text-xs text-muted-foreground"> · {detail}</span>}
                    </span>
                    <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={!canEdit || busyLane === key}
                        data-testid={`restore-lane-${key}`}
                        aria-label={t("projectSettings.languages.restoreLaneAriaLabel", { lane: label })}
                        onClick={() => void handleRestore(key)}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        {busyLane === key ? t("projectSettings.languages.restoringButton") : t("common.restore")}
                      </Button>
                    </DisabledFieldTooltip>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
        </LockedSection>
      </CardContent>
    </Card>
  )
}

/**
 * AQU-1592 — a lane's identity, opened in place: Name, Language and Code, saved
 * together with Save.
 *
 * The LANGUAGE is required (it is what the AI is told and what every "same
 * language?" comparison reads), the NAME is an optional display override whose
 * placeholder is the language itself, and the CODE is an optional override
 * whose placeholder is the derived code.
 *
 * Only fields that changed are submitted, and nothing derived ever is. Blanking
 * the name or the code CLEARS that override rather than writing the derived
 * value back, so editing the language later moves the display and the code
 * with it — the drift that stored derived values caused is AQU-1585.
 */
function LaneEditFields({
  lane,
  focus,
  onSave,
  onDone,
}: {
  lane: ProjectLaneView
  focus: "name" | "language"
  onSave: (laneId: string, edit: LaneIdentityEdit) => Promise<LaneEditResult>
  onDone: () => void
}) {
  const t = useT()
  const storedLanguage = laneLanguage(lane)
  const storedName = lane.name ?? ""
  const storedCode = lane.langCode ?? ""

  const [language, setLanguage] = useState(storedLanguage)
  const [name, setName] = useState(storedName)
  const [code, setCode] = useState(storedCode)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The grey text tracks what is in the language box, including a language
  // typed but not saved yet.
  const derivedCode = useDerivedLanguageCode(language)

  async function save(languageOverride?: string) {
    const nextLanguage = (languageOverride ?? language).trim()
    // Required: an empty language is refused here rather than submitted.
    if (!nextLanguage) {
      setError(t("projectSettings.languages.laneLanguageRequiredError"))
      return
    }
    const edit: LaneIdentityEdit = {}
    if (nextLanguage !== storedLanguage.trim()) edit.language = nextLanguage
    // Blank clears the override — the lane falls back to showing its language.
    if (name.trim() !== storedName.trim()) edit.name = name.trim() || null
    if (code.trim() !== storedCode.trim()) edit.code = code.trim() || null
    if (Object.keys(edit).length === 0) {
      onDone()
      return
    }
    setError(null)
    setSaving(true)
    try {
      const result = await onSave(lane.id, edit)
      if (result === "ok") {
        onDone()
        return
      }
      setError(editResultMessage(result, t))
    } finally {
      setSaving(false)
    }
  }

  function onFieldKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault()
      void save()
    } else if (e.key === "Escape") {
      e.preventDefault()
      onDone()
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`lane-edit-${lane.id}`}>
      {/* AQU-2174: Language, Name, Code — the required field first, matching
          the table's columns and the add form. */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem]">
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={`lane-language-${lane.id}`}>{t("org.orgHome.table.languageHeader")}</FieldLabel>
          <LanguageComboboxInput
            id={`lane-language-${lane.id}`}
            value={language}
            autoFocus={focus === "language"}
            disabled={saving}
            required
            data-testid={`lane-language-${lane.id}`}
            placeholder={t("projectSettings.languages.laneLanguagePlaceholder")}
            className="h-8 text-sm"
            onValueChange={(next) => {
              setLanguage(next)
              setError(null)
            }}
            onEnterSelect={(picked) => {
              setLanguage(picked)
              setError(null)
              void save(picked)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void save()
              }
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={`lane-name-field-${lane.id}`}>{t("common.name")}</FieldLabel>
          <input
            id={`lane-name-field-${lane.id}`}
            value={name}
            autoFocus={focus === "name"}
            disabled={saving}
            data-testid={`lane-name-input-${lane.id}`}
            // The placeholder is the language: that IS what the lane shows when
            // no name is set, so an empty field is not a missing value.
            placeholder={language.trim() || t("projectSettings.languages.laneNamePlaceholder")}
            className={FIELD_INPUT_CLASS}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={onFieldKeyDown}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <FieldLabel htmlFor={`lane-code-${lane.id}`}>{t("projectSettings.languages.codeColumn")}</FieldLabel>
            <InfoHint label={t("projectSettings.languages.codeHintAriaLabel")}>
              {t("projectSettings.languages.laneCodeNote")}
            </InfoHint>
          </div>
          <input
            id={`lane-code-${lane.id}`}
            value={code}
            disabled={saving}
            data-testid={`lane-code-${lane.id}`}
            placeholder={derivedCode ?? t("projectSettings.languages.laneCodeDerivedPlaceholder")}
            className={cn(FIELD_INPUT_CLASS, "font-mono")}
            onChange={(e) => {
              setCode(e.target.value)
              setError(null)
            }}
            onKeyDown={onFieldKeyDown}
          />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" data-testid={`lane-save-${lane.id}`} disabled={saving} onClick={() => void save()}>
          {t("common.save")}
        </Button>
        <Button size="sm" variant="ghost" data-testid={`lane-cancel-${lane.id}`} disabled={saving} onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
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
