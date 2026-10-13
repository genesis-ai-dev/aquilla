import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
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
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { deleteOrg, OrgHasProjectsError, renameOrg } from "@/lib/frontier/orgs"
import { ROLE } from "@/lib/frontier/roles"
import { useSubmitError } from "@/lib/forms/submit-error"
import { orgHomePath, orgOverviewPath } from "@/lib/navigation/org-paths"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsIdentity() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { activeOrg, activeOrgId, refresh, setActiveOrg, setAllOrgs } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canEdit = (activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER
  const canDelete = (activeOrg?.role.level ?? 0) >= ROLE.OWNER

  const [name, setName] = useState(activeOrg?.name ?? "")
  const [nameError, setNameError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  useEffect(() => {
    setName(activeOrg?.name ?? "")
  }, [activeOrg?.name])

  async function handleNameBlur() {
    if (!canEdit || !jwt || activeOrgId == null || activeOrg == null) return
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError("Organization name is required.")
      setName(activeOrg.name ?? "")
      return
    }
    setNameError(null)
    if (trimmed === (activeOrg.name ?? "")) return
    clearSubmitError()
    try {
      await renameOrg(jwt, activeOrgId, trimmed)
      setName(trimmed)
      await refresh()
      toast.add({ type: "success", title: "Organization name updated" })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Couldn't rename your organization.")
      setName(activeOrg.name ?? "")
    }
  }

  async function handleDelete() {
    if (!canDelete || !jwt || activeOrgId == null) return
    const deletedId = activeOrgId
    setDeleting(true)
    clearSubmitError()
    try {
      await deleteOrg(jwt, deletedId)
      const list = await refresh()
      const next = list.find((org) => org.id !== deletedId)
      if (next) {
        setActiveOrg(next.id)
        navigate(orgOverviewPath(next.id))
      } else {
        setAllOrgs()
        navigate(orgHomePath("all"))
      }
    } catch (err) {
      setSubmitError(
        err instanceof OrgHasProjectsError
          ? t("settings.orgIdentity.deleteBlockedProjects")
          : err instanceof Error
            ? err.message
            : t("settings.orgIdentity.deleteFailed"),
      )
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const orgName = activeOrg?.name ?? ""

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.identity}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.identity}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("org.createDialog.nameLabel")}
          description={t("settings.orgIdentity.nameDescription")}
          control={
            <Field
              data-invalid={Boolean(nameError) || undefined}
              data-disabled={!canEdit || undefined}
              className="w-auto *:w-auto"
            >
              <FieldLabel htmlFor="org-settings-name" className="sr-only">
                {t("org.createDialog.nameLabel")}
              </FieldLabel>
              <Input
                id="org-settings-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (nameError) setNameError(null)
                }}
                onBlur={() => {
                  void handleNameBlur()
                }}
                placeholder={t("org.createDialog.nameLabel")}
                aria-invalid={Boolean(nameError) || undefined}
                disabled={!canEdit}
                className="w-56 bg-background"
              />
              {nameError ? <FieldError>{nameError}</FieldError> : null}
            </Field>
          }
        />
      </SettingsGroup>

      {canDelete ? (
        <SettingsGroup label={t("settings.teamSettings.dangerZoneLabel")}>
          <SettingsRow
            label={t("settings.orgIdentity.deleteOrganization")}
            description={t("settings.orgIdentity.deleteRowDescription")}
            control={
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                {t("settings.orgIdentity.deleteOrganization")}
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}

      {submitError ? <FieldError role="alert">{submitError}</FieldError> : null}

      {canDelete ? (
        <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false) }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("org.teamDetail.deleteConfirmTitle", { name: orgName })}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t("settings.orgIdentity.deleteConfirmBody", { name: orgName })}
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
                onClick={() => { void handleDelete() }}
                disabled={deleting}
              >
                {deleting ? t("org.teamDetail.deletingButton") : t("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </OrgSettingsDetailPage>
  )
}
