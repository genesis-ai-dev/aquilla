import { useCallback, useMemo, useState, type ComponentProps } from "react"
import { Check, Search } from "lucide-react"
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/toast"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  ROLE,
  PROJECT_ROLE_OPTIONS,
  LINK_ROLE_OPTIONS,
  roleDisplayText,
  roleName,
  type RoleLevel,
} from "@/lib/frontier/roles"
import { addProjectMember, lookupUser } from "@/lib/frontier/members"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { toUserFacingError } from "@/lib/errors/user-error"
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead"
import { RoleSelect } from "@/components/RoleSelect"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * AQU-1151: above this many rendered rows the checklist switches from a plain
 * `<ul>` to a virtualized LegendList, so a 300-project org does not mount 300
 * rows (each with a tooltip and a conditional role picker) every time the
 * dialog opens or a checkbox toggles. Below the threshold, mounting everything
 * is cheaper than virtualization bookkeeping and the box keeps its natural
 * height, so the common small-org dialog is exactly what it always was.
 */
const VIRTUALIZE_ROW_THRESHOLD = 50
/** An unselected row: `py-2` around a 20px checkbox, plus the 1px divider. */
const ESTIMATED_ROW_HEIGHT_PX = 37
/**
 * The virtualized list needs a definite height to know what is on screen, so
 * it takes the box's old `max-h-64` cap as a fixed height. Only lists longer
 * than the threshold get here, and those always overflowed that cap anyway —
 * the box is the same size it has always been.
 */
const VIRTUAL_LIST_HEIGHT_PX = 256

interface ProjectChecklistRowProps {
  project: CloudProjectSummary
  /** The chosen role, or undefined when the project is not selected. */
  selectedRole: RoleLevel | undefined
  errorMsg: string | undefined
  isDone: boolean
  busy: boolean
  isEmailMode: boolean
  roleChoices: ComponentProps<typeof RoleSelect>["options"]
  onToggle: (projectId: string) => void
  onRoleChange: (projectId: string, level: RoleLevel) => void
  className?: string
}

/**
 * One project row in the add-to-projects checklist. Extracted from the dialog
 * body so both containers render an identical row — the point of AQU-1151 is
 * that virtualization changes only WHICH rows are mounted, never what a row
 * is. It reads its own translations so a locale change reaches mounted rows
 * through context rather than having to travel in LegendList's `extraData`.
 */
function ProjectChecklistRow({
  project,
  selectedRole,
  errorMsg,
  isDone,
  busy,
  isEmailMode,
  roleChoices,
  onToggle,
  onRoleChange,
  className,
}: ProjectChecklistRowProps) {
  const { t } = useI18n()
  const isSelected = selectedRole !== undefined
  return (
    <div
      className={`px-3 py-2 text-sm ${isSelected ? "bg-muted/40" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={t("org.multiProjectInviteDialog.selectProjectAriaLabel", { name: project.name })}
          onClick={() => onToggle(project.id)}
          disabled={busy}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 ${
            isSelected
              ? "bg-primary border-primary text-primary-foreground"
              : "border-muted-foreground/50 bg-background hover:border-primary hover:bg-accent"
          }`}
        >
          {isSelected && <Check className="h-3.5 w-3.5" />}
        </button>
        <AppTooltip content={project.name}>
          <span className="min-w-0">
            <button
              type="button"
              onClick={() => onToggle(project.id)}
              disabled={busy}
              className="min-w-0 truncate text-start hover:text-foreground disabled:opacity-50"
            >
              {project.name}
            </button>
          </span>
        </AppTooltip>
        {isDone ? (
          <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
            <Check className="h-3 w-3" /> {isEmailMode ? "invited" : "added"}
          </span>
        ) : isSelected ? (
          <RoleSelect
            options={roleChoices}
            value={selectedRole}
            onValueChange={(level) => onRoleChange(project.id, level as RoleLevel)}
            disabled={busy}
            size="sm"
            className="shrink-0"
            aria-label={t("org.teamDetail.roleForAriaLabel", { name: project.name })}
          />
        ) : (
          <span aria-hidden className="w-0" />
        )}
      </div>
      {errorMsg && (
        <AppTooltip content={errorMsg} className="max-w-xs">
          <p className="mt-1 ps-7 text-[10px] text-destructive break-words">
            {errorMsg}
          </p>
        </AppTooltip>
      )}
    </div>
  )
}

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
 * - Email mode (new user): AQU-471 — one email-bound single-use invite link is
 *   minted per selected project via POST /projects/:id/invites; the server
 *   delivers each invite email. Roles are capped at the link-share ceiling
 *   (contributor), same as the per-project Share panel.
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
  const { t } = useI18n()
  const { session } = useFrontierSession()
  const [recipient, setRecipient] = useState<RecipientValue>({
    mode: "username",
    raw: "",
  })
  const [selections, setSelections] = useState<Record<string, RoleLevel>>({})
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [perProjectError, setPerProjectError] = useState<Record<string, string>>({})
  const [topError, setTopError] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, "ok"> | null>(null)

  const selectedIds = useMemo(() => Object.keys(selections), [selections])
  // AQU-1150: the filter is presentational only — it narrows which rows are
  // RENDERED, never `selections`. A project checked before the operator types
  // stays selected (and stays in the count, and still gets a grant on submit)
  // even while filtered out of view, which is what "I picked these three, now
  // let me find the fourth" requires.
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])
  const isEmailMode = recipient.mode === "email"
  const emailLooksValid = /\S+@\S+\.\S+/.test(recipient.raw.trim())
  const canSubmit =
    !busy &&
    recipient.raw.trim().length > 0 &&
    (!isEmailMode || emailLooksValid) &&
    selectedIds.length > 0 &&
    Boolean(session?.jwt)

  const toggleProject = useCallback((projectId: string) => {
    setSelections((prev) => {
      const next = { ...prev }
      if (projectId in next) {
        delete next[projectId]
      } else {
        next[projectId] = ROLE.CONTRIBUTOR
      }
      return next
    })
  }, [])

  const setProjectRole = useCallback((projectId: string, level: RoleLevel) => {
    setSelections((prev) => ({ ...prev, [projectId]: level }))
  }, [])

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
      // Email mode (AQU-471): mint one email-bound invite link per project —
      // the server sends each invite email. No pre-existing account needed.
      if (isEmailMode) {
        const email = recipient.raw.trim()
        const jwt = session.jwt
        const results = await Promise.all(
          selectedIds.map((projectId) =>
            createServerInvite(jwt, projectId, selections[projectId], undefined, email)
          )
        )
        const errors: Record<string, string> = {}
        const successes: Record<string, "ok"> = {}
        results.forEach((created, i) => {
          const id = selectedIds[i]
          if (created) {
            successes[id] = "ok"
          } else {
            errors[id] =
              "Couldn't send the invite — you need project-lead access on this project."
          }
        })
        setPerProjectError(errors)
        setDone(successes)
        const sent = Object.keys(successes).length
        if (sent > 0) {
          // AQU-1149: the row badges vanish with the dialog, so the only trace
          // of the outcome has to live at page level. Counts successes only —
          // the failures stay inline, where the operator can act on them.
          toast.add({
            type: "success",
            title: t("org.multiProjectInviteDialog.invitedToast", { count: sent, email }),
          })
          onSuccess?.()
        }
        return
      }
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
          addProjectMember(session.jwt, projectId, target.username, selections[projectId])
        )
      )
      const errors: Record<string, string> = {}
      const successes: Record<string, "ok"> = {}
      results.forEach((r, i) => {
        const id = selectedIds[i]
        if (r.status === "fulfilled") {
          successes[id] = "ok"
        } else {
          errors[id] = toUserFacingError(r.reason, "project").message
        }
      })
      setPerProjectError(errors)
      setDone(successes)
      const added = Object.keys(successes).length
      if (added > 0) {
        toast.add({
          type: "success",
          title: t("org.multiProjectInviteDialog.addedToast", {
            count: added,
            username: target.username,
          }),
        })
        onSuccess?.()
      }
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
    setQuery("")
    setPerProjectError({})
    setTopError(null)
    setDone(null)
    onOpenChange(false)
  }

  // Username mode: cap role picker at maintainer; owner is conferred on
  // creation, never via bulk add. Email mode: link-share invites are capped at
  // contributor server-side, so only offer the link roles.
  const roleChoices = isEmailMode ? LINK_ROLE_OPTIONS : PROJECT_ROLE_OPTIONS

  const renderProjectRow = useCallback(
    (project: CloudProjectSummary, className?: string) => (
      <ProjectChecklistRow
        project={project}
        selectedRole={selections[project.id]}
        errorMsg={perProjectError[project.id]}
        isDone={done?.[project.id] === "ok"}
        busy={busy}
        isEmailMode={isEmailMode}
        roleChoices={roleChoices}
        onToggle={toggleProject}
        onRoleChange={setProjectRole}
        className={className}
      />
    ),
    [selections, perProjectError, done, busy, isEmailMode, roleChoices, toggleProject, setProjectRole],
  )

  // Everything a row reads out of dialog state has to travel in `extraData`:
  // LegendList only re-renders a mounted row when this reference changes, so a
  // value left out of here would leave a checked row looking unchecked (or a
  // failed row without its error) until it scrolled out of view and back.
  const listExtraData = useMemo(
    () => ({ selections, perProjectError, done, busy, isEmailMode }),
    [selections, perProjectError, done, busy, isEmailMode],
  )

  const renderVirtualRow = useCallback(
    ({ item }: LegendListRenderItemProps<CloudProjectSummary>) =>
      renderProjectRow(item, "border-b"),
    [renderProjectRow],
  )

  // Switching to email mode clamps any managerial selections down to the
  // link-share ceiling so the picker value always matches what the server
  // would grant.
  function handleRecipientChange(next: RecipientValue) {
    setRecipient(next)
    if (next.mode === "email") {
      setSelections((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([id, lvl]) => [
            id,
            lvl > ROLE.CONTRIBUTOR ? ROLE.CONTRIBUTOR : lvl,
          ])
        ) as Record<string, RoleLevel>
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : handleClose())}>
      <DialogContent className="w-full max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("org.membersPage.orgPage.addToProjectsButton")}</DialogTitle>
          <DialogDescription>
            {recipient.mode === "email"
              ? "Invite someone by email to multiple projects in one step. Each selected project sends its own single-use invite link — no Aquilla account needed yet."
              : "Add an existing Aquilla user to multiple projects in one step. They get project-only access — org-wide membership is unchanged."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <Field>
            <FieldLabel htmlFor="invite-recipient" className="text-xs">
              {t("org.multiProjectInviteDialog.recipientLabel")}
            </FieldLabel>
            <UsernameTypeahead
              value={recipient}
              onChange={handleRecipientChange}
              disabled={busy}
              inputId="invite-recipient"
              showModeToggle={true}
            />
            {recipient.mode === "email" && (
              <FieldDescription className="text-[10px]">
                {t("org.multiProjectInviteDialog.emailModeHint")}
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel className="text-xs">
              {t("org.multiProjectInviteDialog.projectsFieldLabel")}
            </FieldLabel>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                {t("org.multiProjectInviteDialog.noProjectsAvailable")}
              </p>
            ) : (
              <>
                <div className="relative mt-1.5">
                  <Search
                    className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("org.multiProjectInviteDialog.searchPlaceholder")}
                    aria-label={t("org.multiProjectInviteDialog.searchProjectsAriaLabel")}
                    disabled={busy}
                    className="h-8 ps-7 text-xs"
                  />
                </div>
                {visibleProjects.length === 0 ? (
                  <p className="mt-1.5 text-xs text-muted-foreground py-2">
                    {t("org.orgProjectsDataTable.noSearchMatch")}
                  </p>
                ) : visibleProjects.length > VIRTUALIZE_ROW_THRESHOLD ? (
                  // No list/listitem roles here: LegendList absolutely
                  // positions rows inside its own scroll and spacer elements,
                  // so a `role="list"` wrapper would own non-listitem
                  // children. The per-row checkbox keeps its accessible name,
                  // which is what this control is navigated by.
                  <div
                    data-testid="project-checklist-virtualized"
                    className="mt-1.5 overflow-hidden rounded border"
                    style={{ height: VIRTUAL_LIST_HEIGHT_PX }}
                  >
                    <LegendList
                      data={visibleProjects}
                      extraData={listExtraData}
                      renderItem={renderVirtualRow}
                      keyExtractor={(p) => p.id}
                      estimatedItemSize={ESTIMATED_ROW_HEIGHT_PX}
                      // A row owns popover state (the role picker) and a
                      // tooltip, so recycling one row's DOM into another
                      // project would carry that state across.
                      recycleItems={false}
                      style={{ height: "100%" }}
                      contentContainerStyle={{ width: "100%" }}
                    />
                  </div>
                ) : (
                  <ul className="mt-1.5 max-h-64 overflow-y-auto overflow-x-hidden rounded border divide-y">
                    {visibleProjects.map((p) => (
                      <li key={p.id}>{renderProjectRow(p)}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {selectedIds.length > 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("org.multiProjectInviteDialog.projectsSelectedCount", {
                  count: selectedIds.length,
                })}
                {selectedIds.length > 1 &&
                  t("org.multiProjectInviteDialog.rolesSuffix", {
                    roles: [...new Set(selectedIds.map((id) => selections[id]))]
                      .map((lvl) => roleDisplayText(roleName(lvl)))
                      .join(", "),
                  })}
              </p>
            )}
          </Field>

          {topError && (
            <FieldError className="text-xs">{topError}</FieldError>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              {done ? "Close" : "Cancel"}
            </Button>
            <Button onClick={handleInvite} disabled={!canSubmit}>
              {busy ? (
                <>
                  <Spinner className="me-1" />
                  {isEmailMode ? "Sending…" : "Adding…"}
                </>
              ) : isEmailMode ? (
                <>{t("org.multiProjectInviteDialog.sendInvitesButton")}</>
              ) : (
                <>{t("org.membersPage.orgPage.addToProjectsButton")}</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
