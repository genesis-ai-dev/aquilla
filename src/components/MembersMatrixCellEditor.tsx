import { useState, type ReactNode } from "react"
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
  roleName,
  type RoleLevel,
} from "@/lib/frontier/roles"
import { addProjectMember, removeProjectMember } from "@/lib/frontier/members"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { MatrixCell } from "@/hooks/useProjectsMembersMatrix"

interface CellEditorProps {
  /** Sparse — undefined when the user has no access to the project. */
  cell: MatrixCell | undefined
  userId: number
  username: string
  projectId: string
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
/** AQU-170 vocabulary labels for each grant-path source. */
const SOURCE_LABEL: Record<string, string> = {
  override: "direct",
  group: "via group",
  org: "org-wide",
  creator: "creator",
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
  onMutated,
  cellClassName,
  sourceHint,
  sourceBadge,
  secondarySources = [],
  footer,
}: CellEditorProps) {
  const { session } = useFrontierSession()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const source = cell?.role.source
  const isImmutable =
    source === "creator" || source === "group" || source === "org"
  const canEdit = !isImmutable && Boolean(session?.jwt)

  async function applyRole(level: RoleLevel) {
    if (!session?.jwt) return
    setStatus("submitting")
    setErrorMsg(null)
    try {
      await addProjectMember(session.jwt, projectId, username, level)
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
                aria-label={`Add ${username} to project`}
              />
            }
          >
            <span aria-hidden>—</span>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" side="bottom">
            <RolePickerBody
              title={`Add ${username}`}
              currentLevel={null}
              onPick={applyRole}
              status={status}
              errorMsg={errorMsg}
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
                aria-label={`Edit ${username}'s role on this project`}
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
                  <TooltipContent side="top">
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
                        aria-label="Also has access via other paths"
                      />
                    }
                  >
                    <GitMerge className="h-2.5 w-2.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[200px]">
                    <p className="font-medium mb-1 text-[10px]">Also has access via:</p>
                    <ul className="space-y-0.5">
                      {secondarySources.map((s) => (
                        <li key={s.source} className="text-[10px] capitalize">
                          {SOURCE_LABEL[s.source]} · <RoleLabel name={s.name} />
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
              currentLevel={cell.role.level}
              onPick={applyRole}
              onRemove={removeFromProject}
              status={status}
              errorMsg={errorMsg}
            />
          ) : (
            <ImmutableBody source={cell.role.source} onMakeException={applyRole} status={status} errorMsg={errorMsg} />
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
  currentLevel,
  onPick,
  status,
  errorMsg,
}: {
  title: string
  currentLevel: number | null
  onPick: (level: RoleLevel) => void | Promise<void>
  status: Status
  errorMsg: string | null
}) {
  return (
    <div className="space-y-1.5">
      <div className="px-1 pb-1 text-xs font-medium border-b">{title}</div>
      <div className="space-y-0.5">
        {PROJECT_ROLE_OPTIONS.map((opt) => {
          const isCurrent = opt.level === currentLevel
          return (
            <button
              key={opt.level}
              type="button"
              onClick={() => onPick(opt.level)}
              disabled={status === "submitting" || isCurrent}
              className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-start hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed ${
                isCurrent ? "bg-muted/60" : ""
              }`}
            >
              <span className="text-xs font-medium capitalize">
                <RoleLabel name={opt.name} />
                {isCurrent && (
                  <span className="ms-1.5 text-[9px] text-muted-foreground">current</span>
                )}
              </span>
              <span className="text-[10px] text-muted-foreground">{opt.description}</span>
            </button>
          )
        })}
      </div>
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 pt-1 text-[10px] text-muted-foreground">
          <Spinner className="size-3" />
          Saving…
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
  currentLevel,
  onPick,
  onRemove,
  status,
  errorMsg,
}: {
  username: string
  currentLevel: number
  onPick: (level: RoleLevel) => void | Promise<void>
  onRemove: () => void | Promise<void>
  status: Status
  errorMsg: string | null
}) {
  return (
    <div className="space-y-1.5">
      <RolePickerBody
        title={`Edit ${username}`}
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
          Remove from project
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
  onMakeException,
  status,
  errorMsg,
}: {
  source: string
  onMakeException: (level: RoleLevel) => void | Promise<void>
  status: Status
  errorMsg: string | null
}) {
  if (source === "creator") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">Creator grant</p>
        <p className="text-muted-foreground">
          This person created the project. Their Owner role is permanent until
          project ownership is transferred. The effective role here is Owner
          (max-wins). Manage in the project's Settings → Share.
        </p>
      </div>
    )
  }
  if (source === "group") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">Effective role: via group (max-wins)</p>
        <p className="text-muted-foreground">
          This role comes from a group attached to this project. Edit the
          group's membership to change or remove this grant. To override for
          this project only, add a direct grant below.
        </p>
      </div>
    )
  }
  // source === "org"
  return (
    <div className="space-y-2">
      <div className="text-xs">
        <p className="font-medium">Effective role: org-wide (max-wins)</p>
        <p className="text-muted-foreground">
          This role is granted org-wide and applies to every project. A direct
          project grant added here will supersede the org-wide grant for this
          project only (max-wins still applies — only a higher direct role
          changes the effective role).
        </p>
      </div>
      <div className="border-t pt-1">
        <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
          Set a project-level exception (direct grant)…
        </p>
        <div className="space-y-0.5">
          {PROJECT_ROLE_OPTIONS.filter((o) => o.level <= ROLE.MAINTAINER).map((opt) => (
            <button
              key={opt.level}
              type="button"
              onClick={() => onMakeException(opt.level)}
              disabled={status === "submitting"}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-start text-xs hover:bg-muted disabled:opacity-60"
            >
              <RoleLabel name={opt.name} />
              <RoleLabel name={roleName(opt.level)} className="text-[10px] text-muted-foreground" />
            </button>
          ))}
        </div>
      </div>
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <Spinner className="size-3" /> Saving…
        </div>
      )}
      {status === "error" && errorMsg && (
        <p className="px-1 text-[10px] text-destructive">{errorMsg}</p>
      )}
    </div>
  )
}
