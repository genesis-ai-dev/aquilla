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
import { PageHeader, SettingsGroup, SettingsRow, EmptyState, NotFoundIcon } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { useActiveOrg } from "@/context/OrgContext"
import { useNavHistoryTitle } from "@/context/NavHistoryContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { deleteTeam, getTeam, updateTeam, type TeamDetail as TeamDetailType } from "@/lib/frontier/teams"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useSubmitError } from "@/lib/forms/submit-error"
import { orgPath } from "@/lib/navigation/org-paths"
import { TeamSettingsShell } from "./TeamSettingsShell"

export function TeamSettingsIndex() {
  const { t } = useI18n()
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
      const fetched = await getTeam(jwt, activeOrgId, groupIdNum)
      setTeam(fetched)
      setName(fetched?.name ?? "")
      setDescription(fetched?.description ?? "")
    } catch {
      setTeam(null)
    } finally {
      setLoading(false)
    }
  }, [jwt, activeOrgId, groupIdNum])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const savePatch = useCallback(
    async (patch: { name?: string; description?: string }, successTitle?: string) => {
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
        // Identity-level renames get a toast; routine field saves stay silent.
        if (successTitle) toast.add({ type: "success", title: successTitle })
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
    await savePatch({ description: trimmed })
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
        icon={NotFoundIcon}
        title={t("org.teamDetail.notFoundTitle")}
        description={t("org.teamDetail.notFoundDescription")}
      />
    )
  } else {
    body = (
      <>
        <PageHeader
          title={t("settings.teamSettings.title")}
          description={t("settings.teamSettings.description")}
        />
        <div className="flex flex-col gap-12">
          <SettingsGroup>
            <SettingsRow
              label={t("org.teamForm.nameLabel")}
              description={t("settings.teamSettings.nameRowDescription")}
              control={
                <Field
                  data-invalid={Boolean(nameError) || undefined}
                  data-disabled={!canEdit || undefined}
                  className="w-auto *:w-auto"
                >
                  <FieldLabel htmlFor="team-settings-name" className="sr-only">
                    {t("org.teamForm.nameLabel")}
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
                    placeholder={t("org.teamForm.nameLabel")}
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
                {t("nav.report.descriptionFieldLabel")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("settings.teamSettings.descriptionSummary")}
              </p>
            </div>
            <Field data-disabled={!canEdit || undefined}>
              <FieldLabel htmlFor="team-settings-desc" className="sr-only">
                {t("nav.report.descriptionFieldLabel")}
              </FieldLabel>
              <Textarea
                id="team-settings-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  void handleDescriptionBlur()
                }}
                placeholder={t("settings.teamSettings.descriptionPlaceholder")}
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
            <SettingsGroup label={t("settings.teamSettings.dangerZoneLabel")}>
              <SettingsRow
                label={t("org.teamDetail.deleteTeamButton")}
                description={t("settings.teamSettings.deleteTeamRowDescription")}
                control={
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("org.teamDetail.deleteTeamButton")}
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
                <DialogTitle>{t("org.teamDetail.deleteConfirmTitle", { name: team.name })}</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {t("org.teamDetail.deleteConfirmBody")}
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  {t("common.cancel")}
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
