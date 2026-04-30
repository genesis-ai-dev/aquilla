import { useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  /** Source-label hint used in tooltips. */
  sourceHint: string
}

type Status = "idle" | "submitting" | "error"

/**
 * Inline cell editor for the members × projects matrix. Three behavior modes
 * keyed off the cell's `source`:
 *
 *   - empty (no cell)                → "Add to project" popover with role pick
 *   - source: "override"             → role-pick + Remove (full edit)
 *   - source: "org" / "creator" /    → read-only with explanation; "make
 *     "gitlab"                         exception" affordance for org-source
 *                                      (creates an override that supersedes
 *                                      the inherited grant)
 *
 * Why distinguish: editing creator/gitlab cells from the matrix would be
 * a lie — those grants live elsewhere (project ownership, GitLab access)
 * and silently overwriting them via a project_members override is exactly
 * the "system did something behind your back" failure the design loop
 * called out. The popover names the source so the operator knows where
 * to go to actually edit.
 */
export function MembersMatrixCellEditor({
  cell,
  userId,
  username,
  projectId,
  onMutated,
  cellClassName,
  sourceHint,
}: CellEditorProps) {
  const { session } = useFrontierSession()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const source = cell?.role.source
  const isImmutable =
    source === "creator" || source === "gitlab" || source === "org"
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
      <td className="border-l p-0">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="block w-full px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted/50 disabled:cursor-not-allowed"
                disabled={!session?.jwt}
                title={session?.jwt ? "Add to this project" : "Sign in to manage access"}
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
      </td>
    )
  }

  // Populated cell — render colored badge with role label. Click opens the
  // edit popover (always — even for immutable cells, where the popover
  // shows the explanation).
  return (
    <td className={`border-l p-0 ${cellClassName}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="block w-full px-2 py-1.5 text-left text-[11px] hover:bg-muted/30"
              title={`${cell.role.name}${sourceHint ? ` · ${sourceHint}` : ""}${
                canEdit ? "" : " (read-only here)"
              }`}
              aria-label={`Edit ${username}'s role on this project`}
            />
          }
        >
          <div className="flex items-center justify-between gap-1">
            <span className="capitalize truncate">
              {cell.role.name.replace(/_/g, " ")}
            </span>
            {sourceHint && (
              <span className="text-[9px] opacity-75 shrink-0" aria-hidden>
                {sourceHint[0]}
              </span>
            )}
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
    </td>
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
              className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed ${
                isCurrent ? "bg-muted/60" : ""
              }`}
            >
              <span className="text-xs font-medium capitalize">
                {opt.name.replace(/_/g, " ")}
                {isCurrent && (
                  <span className="ml-1.5 text-[9px] text-muted-foreground">current</span>
                )}
              </span>
              <span className="text-[10px] text-muted-foreground">{opt.description}</span>
            </button>
          )
        })}
      </div>
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 pt-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
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
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Remove from project
        </Button>
      </div>
    </div>
  )
}

/** Read-only explanation for inherited / creator / gitlab cells. */
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
        <p className="font-medium">Project creator</p>
        <p className="text-muted-foreground">
          Owner role is permanent until ownership is transferred. Manage in the
          project's Settings → Share.
        </p>
      </div>
    )
  }
  if (source === "gitlab") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">Granted via GitLab access</p>
        <p className="text-muted-foreground">
          This role comes from the legacy GitLab project. Edit access in
          GitLab; codex will reflect the change on next sync.
        </p>
      </div>
    )
  }
  // source === "org"
  return (
    <div className="space-y-2">
      <div className="text-xs">
        <p className="font-medium">Inherited from org role</p>
        <p className="text-muted-foreground">
          Adding a per-project override here will supersede the org-level grant
          for this project only.
        </p>
      </div>
      <div className="border-t pt-1">
        <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
          Make exception with role…
        </p>
        <div className="space-y-0.5">
          {PROJECT_ROLE_OPTIONS.filter((o) => o.level <= ROLE.MAINTAINER).map((opt) => (
            <button
              key={opt.level}
              type="button"
              onClick={() => onMakeException(opt.level)}
              disabled={status === "submitting"}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-60"
            >
              <span className="capitalize">{opt.name.replace(/_/g, " ")}</span>
              <span className="text-[10px] text-muted-foreground">{roleName(opt.level)}</span>
            </button>
          ))}
        </div>
      </div>
      {status === "submitting" && (
        <div className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </div>
      )}
      {status === "error" && errorMsg && (
        <p className="px-1 text-[10px] text-destructive">{errorMsg}</p>
      )}
    </div>
  )
}
