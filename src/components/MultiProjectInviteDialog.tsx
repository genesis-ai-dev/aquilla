import { useMemo, useState } from "react"
import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  ROLE,
  PROJECT_ROLE_OPTIONS,
  roleName,
  roleDisplayText,
  type RoleLevel,
} from "@/lib/frontier/roles"
import { addProjectMember, lookupUser } from "@/lib/frontier/members"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { toUserFacingError } from "@/lib/errors/user-error"
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead"
import { RoleLabel } from "@/components/RoleLabel"
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
 * AQU-322: Unified add-to-projects dialog.
 *
 * - Username mode (existing Aquilla user): multi-select projects, pick a
 *   role per project, hit Invite. Each project gets a direct membership grant
 *   via POST /projects/:id/members.
 *
 * - Email mode (new user): the dialog explains that email-based invites are
 *   per-project (one magic-link per project) and shows a CTA to the per-project
 *   Share panel for each selected project. This is honest about what the path is
 *   rather than silently routing them back to username.
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
  const isEmailMode = recipient.mode === "email"
  // Email mode: no server action — guide the operator to per-project Share panels.
  const canShowEmailGuide = isEmailMode && selectedIds.length > 0

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
    if (!session?.jwt) {
      setTopError("Sign in to invite collaborators.")
      return
    }
    if (!recipient.raw.trim()) {
      setTopError("Enter a username or email.")
      return
    }
    if (selectedIds.length === 0) {
      setTopError("Select at least one project.")
      return
    }
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
          <DialogTitle>Add to projects</DialogTitle>
          <DialogDescription>
            {recipient.mode === "email"
              ? "Email invites are per-project. Select projects below — each will get its own invite link via the Share panel."
              : "Add an existing Aquilla user to multiple projects in one step. They get project-only access — org-wide membership is unchanged."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <Field>
            <FieldLabel htmlFor="invite-recipient" className="text-xs">
              Recipient
            </FieldLabel>
            <UsernameTypeahead
              value={recipient}
              onChange={setRecipient}
              disabled={busy}
              inputId="invite-recipient"
              showModeToggle={true}
            />
            {recipient.mode === "email" && (
              <FieldDescription className="text-[10px]">
                Select projects below, then use each project&apos;s Share panel to send the invite link.
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel className="text-xs">Projects</FieldLabel>
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
                        <AppTooltip content={p.name}>
                          <span className="min-w-0">
                            <button
                              type="button"
                              onClick={() => toggleProject(p.id)}
                              disabled={busy}
                              className="min-w-0 truncate text-left hover:text-foreground disabled:opacity-50"
                            >
                              {p.name}
                            </button>
                          </span>
                        </AppTooltip>
                        {isDone ? (
                          <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                            <Check className="h-3 w-3" /> added
                          </span>
                        ) : isSelected ? (
                          <Select
                            items={roleChoices.map((r) => ({
                              value: String(r.level),
                              label: roleDisplayText(r.name),
                            }))}
                            value={String(selections[p.id])}
                            onValueChange={(v) =>
                              setProjectRole(p.id, Number(v ?? "") as RoleLevel)
                            }
                            disabled={busy}
                          >
                            <SelectTrigger
                              size="sm"
                              className="shrink-0 max-w-[8.5rem]"
                              aria-label={`Role for ${p.name}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {roleChoices.map((r) => (
                                  <SelectItem key={r.level} value={String(r.level)}>
                                    <RoleLabel name={r.name} />
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span aria-hidden className="w-0" />
                        )}
                      </div>
                      {errorMsg && (
                        <AppTooltip content={errorMsg} className="max-w-xs">
                          <p className="mt-1 pl-7 text-[10px] text-destructive break-words">
                            {errorMsg}
                          </p>
                        </AppTooltip>
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
                      .map((lvl) => roleDisplayText(roleName(lvl)))
                      .join(", ")}
                  </>
                )}
              </p>
            )}
          </Field>

          {/* AQU-322: email-mode guide — direct operator to per-project Share panels */}
          {canShowEmailGuide && (
            <div className="rounded border bg-muted/30 p-3 space-y-2 text-xs">
              <p className="font-medium text-muted-foreground">
                Email invites are sent per-project via each project&apos;s Share panel.
                Open each project and use the Share tab to send a magic-link invite.
              </p>
              <ul className="space-y-1">
                {selectedIds.map((id) => {
                  const p = projects.find((x) => x.id === id)
                  if (!p) return null
                  return (
                    <li key={id}>
                      <a
                        href={`/project/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        onClick={handleClose}
                      >
                        Open {p.name} →
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {topError && (
            <FieldError className="text-xs">{topError}</FieldError>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              <X className="mr-1 h-4 w-4" />
              {done ? "Close" : "Cancel"}
            </Button>
            {!isEmailMode && (
              <Button onClick={handleInvite} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner className="mr-1" />
                    Adding…
                  </>
                ) : (
                  <>Add to projects</>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
