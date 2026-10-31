import { useState, type ReactNode } from "react"
import { useCurrentTargetLanes } from "@/hooks/useCurrentTargetLanes"
import type { MemberLaneAccess } from "@/lib/lanes/lane-access-choice"
import { Trash2, GitMerge, ShieldUser } from "lucide-react"
import type { SecondarySrc } from "@/lib/frontier/members"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { TableCell } from "@/components/ui/table"
import { RoleLabel } from "@/components/RoleLabel"
import { RoleDialog } from "@/components/access/RoleDialog"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { roleChangeBlock } from "@/lib/frontier/member-grants"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { addProjectMember, removeProjectMember } from "@/lib/frontier/members"
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
   * AQU-2289: the caller's own role on this project (the column's
   * `role.level`). Caps the roles the dialog offers and decides whether this
   * member's role may be changed at all. `null` while unknown.
   */
  callerLevel: number | null
  /**
   * Lane scope of this grant. A new cell is every lane. An existing cell uses
   * the scopes already saved, or "unknown" until that fetch lands.
   */
  grantLanes: "all" | "unknown" | readonly string[]
  /** Called after a successful mutation so the matrix can re-fetch. */
  onMutated: () => Promise<void> | void
  /** Visual styling derived by parent (color tier). */
  cellClassName: string
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

/**
 * Inline cell editor for the members × projects matrix. Three behavior modes
 * keyed off the cell's `source`:
 *
 *   - empty (no cell)                → the one RoleDialog adds this person
 *   - source: "override"             → popover: Change role (the RoleDialog)
 *                                      + Remove from project
 *   - source: "org" / "group" /      → read-only with explanation; for an
 *     "creator"                        org-wide cell, "Set a role for this
 *                                      project…" opens the RoleDialog to create
 *                                      a direct grant that supersedes it
 *
 * AQU-2289: every role pick here is the one RoleDialog, so the matrix offers
 * the same project list as every other door, capped at the caller's own role
 * on this project, and says when a member outranks the caller.
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
  callerLevel,
  grantLanes,
  onMutated,
  cellClassName,
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
  const [dialogOpen, setDialogOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // Only an add of someone new asks for Language lanes; load them then.
  const { lanes: targetLanes } = useCurrentTargetLanes(!cell && dialogOpen ? projectId : null)

  const source = cell?.role.source
  const isImmutable =
    source === "creator" || source === "group" || source === "org"
  const canEdit = !isImmutable && Boolean(session?.jwt)
  const block = cell
    ? roleChangeBlock({
        callerLevel,
        targetLevel: cell.role.level,
        isSelf: session?.username != null && session.username === username,
        isLocked: false,
      })
    : null
  const blockNote =
    block === "caller-below-floor"
      ? t("projectSettings.members.roleChangeNeedsRole", { role: resolveRoleName(t, ROLE.PROJECT_LEAD) })
      : block === "target-outranks-caller"
        ? t("projectSettings.members.roleChangeOutranked")
        : null

  /** Saves through the dialog, which shows a failure and stays open. */
  async function grant(level: number, laneAccess?: MemberLaneAccess) {
    if (!session?.jwt) return
    if (laneAccess) {
      await addProjectMember(session.jwt, projectId, username, level, laneAccess)
    } else {
      await addProjectMember(session.jwt, projectId, username, level)
    }
    toast.add({
      type: "success",
      title: describeGrant(t, {
        names: [username],
        roleLevel: level,
        scope: grantScope,
        locale,
      }).sentence,
    })
    await onMutated()
  }

  async function removeFromProject() {
    if (!session?.jwt) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeProjectMember(session.jwt, projectId, userId)
      await onMutated()
      setOpen(false)
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }

  function openDialog() {
    setOpen(false)
    setDialogOpen(true)
  }

  const dialog = (
    <RoleDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      mode="change"
      level="project"
      callerLevel={callerLevel}
      name={username}
      currentLevel={cell?.role.level ?? null}
      where={projectName}
      // Adding someone new: say who joins as what, and where.
      grantScope={cell ? undefined : grantScope}
      targetLanes={cell ? undefined : targetLanes}
      summary={
        source === "org"
          ? t("org.roleDialog.projectExceptionSummary")
          : cell ? t("org.roleDialog.projectChangeSummary") : undefined
      }
      onSave={grant}
      errorMessage={(e) => (e instanceof Error ? e.message : String(e))}
    />
  )

  // Empty cell — a faint "—" that opens the dialog to add this person.
  if (!cell) {
    return (
      <TableCell className="border-s p-0">
        <button
          type="button"
          className="block w-full px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed"
          disabled={!session?.jwt}
          aria-label={t("org.membersMatrixCellEditor.addToProjectAriaLabel", { username })}
          onClick={() => setDialogOpen(true)}
        >
          <span aria-hidden>—</span>
        </button>
        {dialog}
      </TableCell>
    )
  }

  // Populated cell — render colored badge with role label. Click opens the
  // cell's popover (always — even for immutable cells, where the popover
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
              {/* AQU-2260: these two marks say nothing on hover. The cell is
                  itself the button, so what they stand for is in the popover
                  it opens: the legend above the table names each letter, and
                  the other access paths are listed under the role picker. */}
              {sourceBadge && (
                <span
                  aria-hidden
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold ${
                    BADGE_CLASSES[sourceBadge] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {sourceBadge}
                </span>
              )}
              {secondarySources.length > 0 && (
                <span
                  aria-hidden
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground"
                >
                  <GitMerge className="h-2.5 w-2.5" />
                </span>
              )}
            </div>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" side="bottom">
          {canEdit ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 border-b px-1 pb-1 text-xs font-medium">
                <span className="truncate">{t("org.membersMatrixCellEditor.editPopoverTitle", { username })}</span>
                <RoleLabel name={cell.role.level} plain className="shrink-0 font-normal text-muted-foreground" />
              </div>
              {blockNote ? (
                <p className="px-1 text-[11px] text-muted-foreground">{blockNote}</p>
              ) : block === null ? (
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={openDialog}>
                  <ShieldUser className="me-1.5 h-3.5 w-3.5" />
                  {t("org.membersPage.changeRoleAria")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void removeFromProject()}
                disabled={removing}
                className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {removing ? <Spinner className="me-1.5 size-3.5" /> : <Trash2 className="me-1.5 h-3.5 w-3.5" />}
                {t("org.membersMatrixCellEditor.removeFromProject")}
              </Button>
              {removeError && <p className="px-1 text-[10px] text-destructive">{removeError}</p>}
            </div>
          ) : (
            <ImmutableBody
              source={cell.role.source}
              onSetProjectRole={block === null && session?.jwt ? openDialog : undefined}
              blockNote={blockNote}
            />
          )}
          {secondarySources.length > 0 && (
            <div
              className="mt-1.5 border-t px-1 pt-1.5 text-[10px]"
              data-testid="matrix-cell-also-via"
              aria-label={t("org.membersMatrixCellEditor.alsoHasAccessAriaLabel")}
              role="group"
            >
              <p className="mb-1 font-medium">{t("org.membersMatrixCellEditor.alsoHasAccessVia")}</p>
              <ul className="space-y-0.5">
                {secondarySources.map((s) => (
                  <li key={s.source} className="capitalize text-muted-foreground">
                    {t(SOURCE_LABEL[s.source])} · <RoleLabel name={s.name} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {dialog}
      {footer}
    </TableCell>
  )
}

/**
 * Read-only explanation for immutable cells (creator / via group / org-wide).
 *
 * Uses spec vocabulary: grant paths = direct, via group, org-wide, creator;
 * effective role = max-wins. For an org-wide cell, "Set a role for this
 * project…" opens the RoleDialog to create a direct project grant that
 * supersedes the inherited path for this project only.
 */
function ImmutableBody({
  source,
  onSetProjectRole,
  blockNote,
}: {
  source: string
  /** Absent when the caller may not set one (see `blockNote`). */
  onSetProjectRole?: () => void
  blockNote: string | null
}) {
  const t = useT()
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
        {onSetProjectRole ? (
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onSetProjectRole}>
            <ShieldUser className="me-1.5 h-3.5 w-3.5" />
            {t("org.roleDialog.setProjectRole")}
          </Button>
        ) : blockNote ? (
          <p className="px-1 text-[11px] text-muted-foreground">{blockNote}</p>
        ) : null}
      </div>
    </div>
  )
}
