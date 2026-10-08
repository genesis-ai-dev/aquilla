import { useState, type ReactNode } from "react"
import { LaneAccessFields } from "@/components/LaneAccessFields"
import { useCurrentTargetLanes, type TargetLaneOption } from "@/hooks/useCurrentTargetLanes"
import {
  chosenLaneLabels,
  laneChoiceReady,
  needsLaneChoice,
  toMemberLaneAccess,
  type LaneAccessChoice,
  type MemberLaneAccess,
} from "@/lib/lanes/lane-access-choice"
import { Trash2, GitMerge } from "lucide-react"
import type { SecondarySrc } from "@/lib/frontier/members"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { TableCell } from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { RoleLabel } from "@/components/RoleLabel"
import {
  ROLE,
  PROJECT_ROLE_OPTIONS,
  type RoleLevel,
} from "@/lib/frontier/roles"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { addProjectMember, removeProjectMember } from "@/lib/frontier/members"
import { GrantScopeNotice } from "@/components/GrantScopeNotice"
import { toast } from "@/components/ui/toast"
import {
  describeGrant,
  grantProjectName,
  type GrantScope,
} from "@/lib/access/grant-scope-sentence"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { MatrixCell } from "@/hooks/useProjectsMembersMatrix"
import type { MessageKey } from "@/lib/i18n/messages/en"

interface CellEditorProps {
  /** Sparse — undefined when the user has no access to the project. */
  cell: MatrixCell | undefined
  userId: number
  username: string
  projectId: string
  /** Display name of the project column. */
  projectName: string
  /**
   * Lane scope of this grant. A new cell is every lane. An existing cell uses
   * the scopes already saved, or "unknown" until that fetch lands.
   */
  grantLanes: "all" | "unknown" | readonly string[]
  /** Called after a successful mutation so the matrix can re-fetch. */
  onMutated: () => Promise<void> | void
  /** Visual styling derived by parent (color tier). */
  cellClassName: string
  /** Source-label hint used in tooltips (e.g. "org-wide", "direct"). */
  sourceHint: string
  /** 1-char badge code: D (direct), O (org-wide), G (via group), C (creator). */
  sourceBadge: string
  /** Non-winning contributing paths from the server. Empty = single path. */
  secondarySources?: SecondarySrc[]
  /**
   * AQU-538 §3.4: optional extra content rendered under the role, inside the
   * same cell — the matrix's lane-scope chips + scope-editor affordance.
   * Purely additive (undefined = no visual change), so this component's
   * existing role-edit behavior is untouched when the caller doesn't pass it.
   */
  footer?: ReactNode
}

type Status = "idle" | "submitting" | "error"

/**
 * Inline cell editor for the members × projects matrix. Three behavior modes
 * keyed off the cell's `source`:
 *
 *   - empty (no cell)                → "Add to project" popover with role pick
 *   - source: "override"             → role-pick + Remove (full edit)
 *   - source: "org" / "group" /      → read-only with explanation; "make
 *     "creator"                        exception" affordance for org/group-source
 *                                      (creates an override that supersedes
 *                                      the inherited grant)
 *
 * Why distinguish: editing creator/group/org cells from the matrix would be
 * a lie — those grants live elsewhere (project ownership, org membership,
 * group membership) and silently overwriting them via a project_members
 * override is exactly the "system did something behind your back" failure.
 * The popover names the source so the operator knows where to go to edit.
 */
/**
 * AQU-170 vocabulary labels for each grant-path source. Catalog keys, not
 * display strings — resolved with `t()` at the render site below. Every
 * entry reuses an identical-text badge already minted elsewhere
 * (org.accessModelLegend.direct.label / .orgWide.label /
 * org.membersPanel.sourceViaGroup / org.memberAccessPanel.creatorGrantLabel
 * — the surrounding `capitalize` CSS class means the reused keys' Title
 * Case renders identically to the lowercase this list otherwise uses)
 * rather than minting duplicate keys for the same words.
 */
const SOURCE_LABEL: Record<string, MessageKey> = {
  override: "org.accessModelLegend.direct.label",
  group: "org.membersPanel.sourceViaGroup",
  org: "org.accessModelLegend.orgWide.label",
  creator: "org.memberAccessPanel.creatorGrantLabel",
}

/** Badge color classes keyed by badge letter. */
const BADGE_CLASSES: Record<string, string> = {
  D: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  G: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  O: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  C: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
}

export function MembersMatrixCellEditor({
  cell,
  userId,
  username,
  projectId,
  projectName,
  grantLanes,
  onMutated,
  cellClassName,
  sourceHint,
  sourceBadge,
  secondarySources = [],
  footer,
}: CellEditorProps) {
  const t = useT()
  const { locale } = useI18n()
  const { session } = useFrontierSession()
  const grantScope: GrantScope = {
    kind: "project",
    projectName: grantProjectName(t, projectName),
    lanes: grantLanes,
  }
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { lanes: targetLanes } = useCurrentTargetLanes(!cell && open ? projectId : null)

  const source = cell?.role.source
  const isImmutable =
    source === "creator" || source === "group" || source === "org"
  const canEdit = !isImmutable && Boolean(session?.jwt)

  async function applyRole(level: RoleLevel, laneAccess?: MemberLaneAccess) {
    if (!session?.jwt) return
    setStatus("submitting")
    setErrorMsg(null)
    try {
      if (laneAccess) {
        await addProjectMember(session.jwt, projectId, username, level, laneAccess)
      } else {
        await addProjectMember(session.jwt, projectId, username, level)
      }
      const scope = grantScopeWithChoice(grantScope, targetLanes, level, laneAccess, false)
      toast.add({
        type: "success",
        title: describeGrant(t, {
          names: [username],
          roleLevel: level,
          scope,
          locale,
        }).sentence,
      })
      await onMutated()
      setOpen(false)
      setStatus("idle")
    } catch (e) {
      setStatus("error")
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeFromProject() {
    if (!session?.jwt) return
    setStatus("submitting")
    setErrorMsg(null)
    try {
      await removeProjectMember(session.jwt, projectId, userId)
      await onMutated()
      setOpen(false)
      setStatus("idle")
    } catch (e) {
      setStatus("error")
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }

  // Empty cell — render as a faint "+" affordance when editable, plain "—"
  // otherwise. Click opens the add-role popover.
  if (!cell) {
    return (
      <TableCell className="border-s p-0">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="block w-full px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed"
                disabled={!session?.jwt}
                aria-label={t("org.membersMatrixCellEditor.addToProjectAriaLabel", { username })}
              />
            }
          >
            <span aria-hidden>—</span>
          </PopoverTrigger>
          <PopoverContent className={targetLanes.length > 0 ? "w-72 p-2" : "w-56 p-2"} side="bottom">
            <RolePickerBody
              title={t("workspace.typeahead.addUser", { username })}
              username={username}
              grantScope={grantScope}
              currentLevel={null}
              onPick={applyRole}
              status={status}
              errorMsg={errorMsg}
              targetLanes={targetLanes}
            />
          </PopoverContent>
        </Popover>
      </TableCell>
    )
  }

  // Populated cell — render colored badge with role label. Click opens the
  // edit popover (always — even for immutable cells, where the popover
  // shows the explanation).
  return (
    <TableCell className={`border-s p-0 ${cellClassName}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
              <button
                type="button"
                className="block w-full px-2 py-1.5 text-start text-[11px] hover:bg-muted/30"
                aria-label={t("org.membersMatrixCellEditor.editRoleAriaLabel", { username })}
              />
          }
        >
          <div className="flex items-center justify-between gap-1">
            <RoleLabel name={cell.role.name} className="truncate" />
            <div className="flex items-center gap-0.5 shrink-0">
              {sourceBadge && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold cursor-default ${
                          BADGE_CLASSES[sourceBadge] ?? "bg-muted text-muted-foreground"
                        }`}
                        aria-label={sourceHint}
                      />
                    }
                  >
                    {sourceBadge}
                  </TooltipTrigger>
                  <TooltipContent>
                    {sourceHint}
                  </TooltipContent>
                </Tooltip>
              )}
              {secondarySources.length > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded cursor-default text-muted-foreground hover:text-foreground"
                        aria-label={t("org.membersMatrixCellEditor.alsoHasAccessAriaLabel")}
                      />
                    }
                  >
                    <GitMerge className="h-2.5 w-2.5" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[200px]">
                    <p className="font-medium mb-1 text-[10px]">
                      {t("org.membersMatrixCellEditor.alsoHasAccessVia")}
                    </p>
                    <ul className="space-y-0.5">
                      {secondarySources.map((s) => (
                        <li key={s.source} className="text-[10px] capitalize">
                          {t(SOURCE_LABEL[s.source])} · <RoleLabel name={s.name} />
                        </li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" side="bottom">
          {canEdit ? (
            <EditableBody
              username={username}
              grantScope={grantScope}
              currentLevel={cell.role.level}
              onPick={applyRole}
              onRemove={removeFromProject}
              status={status}
              errorMsg={errorMsg}
            />
          ) : (
            <ImmutableBody
              source={cell.role.source}
              username={username}
              grantScope={grantScope}
              onMakeException={applyRole}
              status={status}
              errorMsg={errorMsg}
            />
          )}
        </PopoverContent>
      </Popover>
      {footer}
    </TableCell>
  )
}

/** Picker shown when adding a new project member. */
function RolePickerBody({
  title,
  username,
  grantScope,
  currentLevel,
  onPick,
  status,
  errorMsg,
  targetLanes,
}: {
  title: string
  username: string
  grantScope: GrantScope
  currentLevel: number | null
  onPick: (level: RoleLevel, laneAccess?: MemberLaneAccess) => void | Promise<void>
  status: Status
  errorMsg: string | null
  /** Set only when this picker is adding a new member. A role change omits it. */
  targetLanes?: readonly TargetLaneOption[]
}) {
  const { t, locale } = useI18n()
  // The role buttons are the submit, except a new member below project lead
  // on a project that has lanes: that pick waits for an explicit lane choice.
  const [preview, setPreview] = useState<number | null>(null)
  const [pendingLevel, setPendingLevel] = useState<RoleLevel | null>(null)
  const [laneChoice, setLaneChoice] = useState<LaneAccessChoice | null>(null)
  const shown = preview ?? pendingLevel ?? currentLevel ?? PROJECT_ROLE_OPTIONS[0].level
  const lanes = targetLanes ?? []
  const confirming = pendingLevel !== null && needsLaneChoice(pendingLevel, lanes.length)
  const copy = describeGrant(t, {
    names: [username],
    roleLevel: shown,
    scope: grantScopeWithChoice(
      grantScope,
      lanes,
      shown,
      pendingLevel === shown && laneChoice ? toMemberLaneAccess(laneChoice) : undefined,
      Boolean(targetLanes),
    ),
    locale,
  })
  function handlePick(level: RoleLevel) {
    if (targetLanes && needsLaneChoice(level, targetLanes.length)) {
      setPendingLevel(level)
      return
    }
    void onPick(level)
  }
  return (
    <div className="space-y-1.5">
      <div className="px-1 pb-1 text-xs font-medium border-b">{title}</div>
      <GrantScopeNotice sentence={copy.sentence} />
      <div className="space-y-0.5">
        {PROJECT_ROLE_OPTIONS.map((opt) => {
          const isCurrent = opt.level === currentLevel
          return (
            <button
              key={opt.level}
              type="button"
              onClick={() => handlePick(opt.level)}
              onMouseEnter={() => setPreview(opt.level)}
              onFocus={() => setPreview(opt.level)}
              disabled={status === "submitting" || isCurrent}
              className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-start hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed ${
                isCurrent ? "bg-muted/60" : ""
              }`}
            >
              <span className="text-xs font-medium">
                <span className="capitalize">
                  <RoleLabel name={opt.name} plain />
                </span>
                <span className="font-normal text-muted-foreground"> — {copy.scopeEcho}</span>
                {isCurrent && (
                  <span className="ms-1.5 text-[9px] text-muted-foreground">
                    {t("org.membersMatrixCellEditor.currentBadge")}
                  </span>
                )}
              </span>
              <span className="text-[10px] text-muted-foreground">{t(opt.descriptionKey)}</span>
            </button>
          )
        })}
      </div>
      {confirming && pendingLevel !== null && (
        <div className="space-y-1.5 px-1 pt-1">
          <LaneAccessFields
            name={`matrix-lane-${username}`}
            lanes={lanes}
            value={laneChoice}
            onChange={setLaneChoice}
            disabled={status === "submitting"}
          />
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={!laneChoiceReady(laneChoice, pendingLevel, lanes.length) || status === "submitting"}
            onClick={() => {
              if (!laneChoice) return
              void onPick(pendingLevel, toMemberLaneAccess(laneChoice))
            }}
          >
            {t("common.add")}
          </Button>
        </div>
      )}
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 pt-1 text-[10px] text-muted-foreground">
          <Spinner className="size-3" />
          {t("common.saving")}
        </div>
      )}
      {status === "error" && errorMsg && (
        <p className="px-1 pt-1 text-[10px] text-destructive">{errorMsg}</p>
      )}
    </div>
  )
}

/** Picker + Remove for editable (override) cells. */
function EditableBody({
  username,
  grantScope,
  currentLevel,
  onPick,
  onRemove,
  status,
  errorMsg,
}: {
  username: string
  grantScope: GrantScope
  currentLevel: number
  onPick: (level: RoleLevel) => void | Promise<void>
  onRemove: () => void | Promise<void>
  status: Status
  errorMsg: string | null
}) {
  const t = useT()
  return (
    <div className="space-y-1.5">
      <RolePickerBody
        title={t("org.membersMatrixCellEditor.editPopoverTitle", { username })}
        username={username}
        grantScope={grantScope}
        currentLevel={currentLevel}
        onPick={onPick}
        status={status}
        errorMsg={errorMsg}
      />
      <div className="border-t pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={status === "submitting"}
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="me-1.5 h-3.5 w-3.5" />
          {t("org.membersMatrixCellEditor.removeFromProject")}
        </Button>
      </div>
    </div>
  )
}

/**
 * Read-only explanation for immutable cells (creator / via group / org-wide).
 *
 * Uses spec vocabulary: grant paths = direct, via group, org-wide, creator;
 * effective role = max-wins. The "Make exception" CTA creates a direct project
 * grant that supersedes the inherited path for this project only.
 */
function ImmutableBody({
  source,
  username,
  grantScope,
  onMakeException,
  status,
  errorMsg,
}: {
  source: string
  username: string
  grantScope: GrantScope
  onMakeException: (level: RoleLevel) => void | Promise<void>
  status: Status
  errorMsg: string | null
}) {
  const { t, locale } = useI18n()
  const exceptionRoles = PROJECT_ROLE_OPTIONS.filter((o) => o.level <= ROLE.MAINTAINER)
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? exceptionRoles[0]?.level ?? ROLE.CONTRIBUTOR
  const copy = describeGrant(t, {
    names: [username],
    roleLevel: shown,
    scope: grantScope,
    locale,
  })
  if (source === "creator") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">{t("org.membersMatrixCellEditor.creatorGrantHeading")}</p>
        <p className="text-muted-foreground">
          {t("org.membersMatrixCellEditor.creatorGrantDescription")}
        </p>
      </div>
    )
  }
  if (source === "group") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">{t("org.membersMatrixCellEditor.viaGroupHeading")}</p>
        <p className="text-muted-foreground">
          {t("org.membersMatrixCellEditor.viaGroupDescription")}
        </p>
      </div>
    )
  }
  // source === "org"
  return (
    <div className="space-y-2">
      <div className="text-xs">
        <p className="font-medium">{t("org.membersMatrixCellEditor.orgWideHeading")}</p>
        <p className="text-muted-foreground">
          {t("org.membersMatrixCellEditor.orgWideDescription")}
        </p>
      </div>
      <div className="border-t pt-1">
        <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
          {t("org.membersMatrixCellEditor.setExceptionLabel")}
        </p>
        <GrantScopeNotice sentence={copy.sentence} />
        <div className="space-y-0.5">
          {exceptionRoles.map((opt) => (
            <button
              key={opt.level}
              type="button"
              onClick={() => onMakeException(opt.level)}
              onMouseEnter={() => setPreview(opt.level)}
              onFocus={() => setPreview(opt.level)}
              disabled={status === "submitting"}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-start text-xs hover:bg-muted disabled:opacity-60"
            >
              <span>
                <RoleLabel name={opt.name} plain />
                <span className="text-muted-foreground"> — {copy.scopeEcho}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <Spinner className="size-3" /> {t("common.saving")}
        </div>
      )}
      {status === "error" && errorMsg && (
        <p className="px-1 text-[10px] text-destructive">{errorMsg}</p>
      )}
    </div>
  )
}

function grantScopeWithChoice(
  scope: GrantScope,
  lanes: readonly TargetLaneOption[],
  role: number,
  laneAccess: MemberLaneAccess | undefined,
  unchosen: boolean,
): GrantScope {
  if (scope.kind !== "project" || !needsLaneChoice(role, lanes.length)) return scope
  if (!laneAccess) return unchosen ? { ...scope, lanes: "unknown" } : scope
  return {
    ...scope,
    lanes: chosenLaneLabels(
      lanes,
      role,
      "allCurrentLanes" in laneAccess
        ? { kind: "all" }
        : { kind: "lanes", laneIds: laneAccess.scopeLanes },
    ),
  }
}
