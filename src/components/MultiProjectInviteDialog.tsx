import { useMemo, useState } from "react"
import { Check, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  ROLE,
  PROJECT_ROLE_OPTIONS,
  roleName,
  type RoleLevel,
} from "@/lib/frontier/roles"
import { addProjectMember, lookupUser } from "@/lib/frontier/members"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { toUserFacingError } from "@/lib/errors/user-error"
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

interface MultiProjectInviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Projects the operator can invite to (already filtered to those they
   * have permission on). Comes from useAccessibleProjects. */
  projects: CloudProjectSummary[]
  /** Fired after a successful invite so the parent can refresh dependent
   * state (e.g. roster project chips). */
  onSuccess?: () => void
}

/**
 * Operational PM's bulk-add flow. Type a username, multi-select projects,
 * pick a role per project, hit Invite. Each project gets its own
 * POST /projects/:id/members; failures are surfaced per-row so the
 * operator knows which ones landed.
 *
 * Why per-project role (not "set all to role X"): translation projects
 * have meaningful per-project role variation — someone might be Translator
 * on Genesis but Reviewer on Exodus. Per-row picker keeps the right
 * granularity at the moment of invite, when the operator's intent is
 * clearest. A "set all" shortcut is a future polish; the granular form
 * is the load-bearing primitive.
 */
export function MultiProjectInviteDialog({
  open,
  onOpenChange,
  projects,
  onSuccess,
}: MultiProjectInviteDialogProps) {
  const { session } = useFrontierSession()
  // Username-only here. Multi-project email invites would need N tokens
  // (one per project), each bearing the same email — awkward UX. The
  // single-project email-invite path lives in SharePanel; once the
  // recipient signs up there, they become a known user the operator
  // can bulk-add by username from this dialog.
  const [recipient, setRecipient] = useState<RecipientValue>({
    mode: "username",
    raw: "",
  })
  const [selections, setSelections] = useState<Record<string, RoleLevel>>({})
  const [busy, setBusy] = useState(false)
  const [perProjectError, setPerProjectError] = useState<Record<string, string>>({})
  const [topError, setTopError] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, "ok"> | null>(null)

  const selectedIds = useMemo(() => Object.keys(selections), [selections])
  const canSubmit =
    !busy && recipient.raw.trim().length > 0 && selectedIds.length > 0 && Boolean(session?.jwt)

  function toggleProject(projectId: string) {
    setSelections((prev) => {
      const next = { ...prev }
      if (projectId in next) {
        delete next[projectId]
      } else {
        next[projectId] = ROLE.CONTRIBUTOR
      }
      return next
    })
  }

  function setProjectRole(projectId: string, level: RoleLevel) {
    setSelections((prev) => ({ ...prev, [projectId]: level }))
  }

  async function handleInvite() {
    if (!session?.jwt) return
    setBusy(true)
    setTopError(null)
    setPerProjectError({})
    setDone(null)
    try {
      // If the typeahead already verified the user, skip the redundant
      // round-trip. Otherwise (operator typed and hit Add without picking
      // a suggestion) fall back to a definitive lookup.
      const target =
        recipient.resolved ??
        (await lookupUser(session.jwt, recipient.raw.trim()))
      if (!target) {
        setTopError(`No Aquilla user named "${recipient.raw.trim()}".`)
        return
      }
      // Issue grants in parallel — they're independent and we want the
      // round-trip cost to be O(1) round-trips, not O(N).
      const results = await Promise.allSettled(
        selectedIds.map((projectId) =>
          addProjectMember(session.jwt, projectId, target.username, selections[projectId]!)
        )
      )
      const errors: Record<string, string> = {}
      const successes: Record<string, "ok"> = {}
      results.forEach((r, i) => {
        const id = selectedIds[i]!
        if (r.status === "fulfilled") {
          successes[id] = "ok"
        } else {
          errors[id] = toUserFacingError(r.reason, "project").message
        }
      })
      setPerProjectError(errors)
      setDone(successes)
      if (Object.keys(successes).length > 0) onSuccess?.()
    } catch (err) {
      setTopError(toUserFacingError(err, "project").message)
    } finally {
      setBusy(false)
    }
  }

  function handleClose() {
    if (busy) return
    setRecipient({ mode: "username", raw: "" })
    setSelections({})
    setPerProjectError({})
    setTopError(null)
    setDone(null)
    onOpenChange(false)
  }

  // Cap role picker at maintainer; owner is conferred on creation, never via
  // bulk add. Mirrors PROJECT_ROLE_OPTIONS but only the levels we want here.
  const roleChoices = PROJECT_ROLE_OPTIONS

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : handleClose())}>
      <DialogContent className="w-full max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Invite to projects</DialogTitle>
          <DialogDescription>
            Add someone to multiple projects in one step. They get
            <strong className="font-medium"> project-only access</strong>{" "}
            — org-wide membership is unchanged. If the person is already in
            your org, this adds project-level overrides on top of their
            existing org role.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-username" className="text-xs">
              Aquilla username
            </Label>
            <UsernameTypeahead
              value={recipient}
              onChange={setRecipient}
              disabled={busy}
              inputId="invite-username"
              showModeToggle={false}
            />
            <p className="text-[10px] text-muted-foreground">
              Invite by email is in the per-project Share panel — once they
              sign up, you can bulk-add them here.
            </p>
          </div>

          <div>
            <Label className="text-xs">Projects</Label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                No projects available — create one first or check back when sync completes.
              </p>
            ) : (
              <ul className="mt-1.5 max-h-64 overflow-y-auto overflow-x-hidden rounded border divide-y">
                {projects.map((p) => {
                  const isSelected = p.id in selections
                  const errorMsg = perProjectError[p.id]
                  const isDone = done?.[p.id] === "ok"
                  return (
                    <li
                      key={p.id}
                      className={`px-3 py-2 text-sm ${
                        isSelected ? "bg-muted/40" : ""
                      }`}
                    >
                      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={`Select ${p.name}`}
                          onClick={() => toggleProject(p.id)}
                          disabled={busy}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 ${
                            isSelected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-muted-foreground/50 bg-background hover:border-primary hover:bg-accent"
                          }`}
                        >
                          {isSelected && <Check className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleProject(p.id)}
                          disabled={busy}
                          title={p.name}
                          className="min-w-0 truncate text-left hover:text-foreground disabled:opacity-50"
                        >
                          {p.name}
                        </button>
                        {isDone ? (
                          <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                            <Check className="h-3 w-3" /> added
                          </span>
                        ) : isSelected ? (
                          <select
                            className="shrink-0 max-w-[8.5rem] rounded border bg-background px-2 py-1 text-xs"
                            value={selections[p.id]}
                            onChange={(e) =>
                              setProjectRole(p.id, Number(e.target.value) as RoleLevel)
                            }
                            disabled={busy}
                          >
                            {roleChoices.map((r) => (
                              <option key={r.level} value={r.level}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span aria-hidden className="w-0" />
                        )}
                      </div>
                      {errorMsg && (
                        <p
                          className="mt-1 pl-7 text-[10px] text-destructive break-words"
                          title={errorMsg}
                        >
                          {errorMsg}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {selectedIds.length > 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {selectedIds.length} project{selectedIds.length === 1 ? "" : "s"} selected
                {selectedIds.length > 1 && (
                  <>
                    {" "}— roles:{" "}
                    {[...new Set(selectedIds.map((id) => selections[id]!))]
                      .map((lvl) => roleName(lvl))
                      .join(", ")}
                  </>
                )}
              </p>
            )}
          </div>

          {topError && (
            <p className="text-xs text-destructive">{topError}</p>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              <X className="mr-1 h-4 w-4" />
              {done ? "Close" : "Cancel"}
            </Button>
            <Button onClick={handleInvite} disabled={!canSubmit}>
              {busy ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Inviting…
                </>
              ) : (
                <>Invite</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
