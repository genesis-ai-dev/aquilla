import { useEffect, useState } from "react"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { renameOrg } from "@/lib/frontier/orgs"
import { useSubmitError } from "@/lib/forms/submit-error"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsIdentity() {
  const { activeOrg, activeOrgId, refresh } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canEdit = (activeOrg?.role.level ?? 0) >= 600

  const [name, setName] = useState(activeOrg?.name ?? "")
  const [nameError, setNameError] = useState<string | null>(null)
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

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.identity}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.identity}
    >
      <SettingsGroup>
        <SettingsRow
          label="Organization name"
          description="Shown across the workspace."
          control={
            <Field
              data-invalid={Boolean(nameError) || undefined}
              data-disabled={!canEdit || undefined}
              className="w-auto *:w-auto"
            >
              <FieldLabel htmlFor="org-settings-name" className="sr-only">
                Organization name
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
                placeholder="Organization name"
                aria-invalid={Boolean(nameError) || undefined}
                disabled={!canEdit}
                className="w-56 bg-background"
              />
              {nameError ? <FieldError>{nameError}</FieldError> : null}
            </Field>
          }
        />
      </SettingsGroup>

      {submitError ? <FieldError role="alert">{submitError}</FieldError> : null}
    </OrgSettingsDetailPage>
  )
}
