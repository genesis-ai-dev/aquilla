import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PageHeader, SettingsGroup, SettingsRow, EmptyState } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { useActiveOrg } from "@/context/OrgContext"
import { useNavHistoryTitle } from "@/context/NavHistoryContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { deleteTeam, getTeam, updateTeam, type TeamDetail as TeamDetailType } from "@/lib/frontier/teams"
import { useSubmitError } from "@/lib/forms/submit-error"
import { orgPath } from "@/lib/navigation/org-paths"
import { TeamSettingsShell } from "./TeamSettingsShell"

export function TeamSettingsIndex() {
  const { groupId } = useParams<{ groupId: string }>()
  const groupIdNum = groupId != null ? Number(groupId) : null
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600
  const canEdit = isAdmin

  const [team, setTeam] = useState<TeamDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()
  useNavHistoryTitle(team?.name)

  const refetch = useCallback(async () => {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setLoading(true)
    try {
      const t = await getTeam(jwt, activeOrgId, groupIdNum)
      setTeam(t)
      setName(t?.name ?? "")
      setDescription(t?.description ?? "")
    } finally {
      setLoading(false)
    }
  }, [jwt, activeOrgId, groupIdNum])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const savePatch = useCallback(
    async (patch: { name?: string; description?: string }, successTitle: string) => {
      if (!jwt || activeOrgId == null || groupIdNum == null || !canEdit) return
      clearSubmitError()
      try {
        const updated = await updateTeam(jwt, activeOrgId, groupIdNum, patch)
        setTeam((prev) =>
          prev
            ? { ...prev, name: updated.name, description: updated.description }
            : prev,
        )
        setName(updated.name)
        setDescription(updated.description ?? "")
        toast.add({ type: "success", title: successTitle })
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Couldn't save team.")
      }
    },
    [jwt, activeOrgId, groupIdNum, canEdit, clearSubmitError, setSubmitError],
  )

  async function handleNameBlur() {
    if (!canEdit || team == null) return
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError("Team name is required.")
      setName(team.name)
      return
    }
    setNameError(null)
    if (trimmed === team.name) return
    await savePatch({ name: trimmed }, "Team name updated")
  }

  async function handleDescriptionBlur() {
    if (!canEdit || team == null) return
    const trimmed = description.trim()
    const current = team.description ?? ""
    if (trimmed === current) return
    await savePatch({ description: trimmed }, "Description updated")
  }

  async function handleDelete() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setDeleting(true)
    try {
      await deleteTeam(jwt, activeOrgId, groupIdNum)
      navigate(orgPath(activeOrgId, "/teams"))
    } finally {
      setDeleting(false)
    }
  }

  if (activeOrgId == null || groupIdNum == null) return null

  const teamDetail = orgPath(activeOrgId, `/teams/${groupIdNum}`)

  let body
  if (loading) {
    body = (
      <div className="flex flex-col gap-12">
        <div className="h-28 animate-pulse rounded-lg border bg-card" />
        <div className="h-40 animate-pulse rounded-lg border bg-card" />
      </div>
    )
  } else if (team == null) {
    body = (
      <EmptyState
        title="Team not found."
        description="This team may have been deleted, or you may not have access to it."
      />
    )
  } else {
    body = (
      <>
        <PageHeader
          title="Team settings"
          description="Manage this team's name, description, and membership grants."
        />
        <div className="flex flex-col gap-12">
          <SettingsGroup>
            <SettingsRow
              label="Team name"
              description="Shown on the team page and in organization lists."
              control={
                <Field
                  data-invalid={Boolean(nameError) || undefined}
                  data-disabled={!canEdit || undefined}
                  className="w-auto *:w-auto"
                >
                  <FieldLabel htmlFor="team-settings-name" className="sr-only">
                    Team name
                  </FieldLabel>
                  <Input
                    id="team-settings-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      if (nameError) setNameError(null)
                    }}
                    onBlur={() => {
                      void handleNameBlur()
                    }}
                    placeholder="Team name"
                    aria-invalid={Boolean(nameError) || undefined}
                    disabled={!canEdit}
                    className="w-56 bg-background"
                  />
                  {nameError ? <FieldError>{nameError}</FieldError> : null}
                </Field>
              }
            />
          </SettingsGroup>

          <div className="flex flex-col gap-3">
            <div className="min-w-0 space-y-1 pl-4">
              <p className="font-heading text-base font-medium tracking-tight text-foreground">
                Description
              </p>
              <p className="text-sm text-muted-foreground">
                A short summary shown on the team page.
              </p>
            </div>
            <Field data-disabled={!canEdit || undefined}>
              <FieldLabel htmlFor="team-settings-desc" className="sr-only">
                Description
              </FieldLabel>
              <Textarea
                id="team-settings-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  void handleDescriptionBlur()
                }}
                placeholder="Add a description…"
                disabled={!canEdit}
                rows={5}
                className="min-h-24 resize-none bg-card px-4 py-3"
              />
            </Field>
          </div>

          {submitError ? (
            <FieldError role="alert">{submitError}</FieldError>
          ) : null}

          {isAdmin ? (
            <SettingsGroup label="Danger zone">
              <SettingsRow
                label="Delete team"
                description="Permanently remove this team and all of its project grants. Members keep their org roles."
                control={
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete team
                  </Button>
                }
              />
            </SettingsGroup>
          ) : null}
        </div>

        {isAdmin ? (
          <Dialog open={confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(false) }}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Delete &apos;{team.name}&apos;?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This removes the team and all its grants.
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </>
    )
  }

  return (
    <TeamSettingsShell
      header={
        <OrgBreadcrumb
          parent={{ label: team?.name ?? "Team", to: teamDetail }}
          section="Settings"
        />
      }
    >
      {body}
    </TeamSettingsShell>
  )
}
