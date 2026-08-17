// AQU-433: Org-level provider API key management.
//
// Displayed inside the org Settings page. Editable only by org maintainer+.
// The key is stored in OrgWideSettings.orgProviderKeys and synced via the
// existing org-settings sync route — no new routes needed.
//
// Precedence at synthesis time:
//   project key > user (localStorage) key > org key (this section)

import { useEffect } from "react"
import { useForm } from "@tanstack/react-form"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import { z } from "zod"

const formSchema = z.object({
  geminiKey: optionalString,
})

interface OrgProviderSectionProps {
  orgSettings: UseOrgSettings
}

export function OrgProviderSection({ orgSettings }: OrgProviderSectionProps) {
  const { t } = useI18n()
  const { orgProviderKeys, canEditOrgKeys, patch, hasFetched } = orgSettings

  const keys = orgProviderKeys ?? {}
  const currentGeminiKey = keys["gemini-tts"] ?? ""
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { geminiKey: currentGeminiKey },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      if (!canEditOrgKeys) return
      clearSubmitError()
      const trimmed = value.geminiKey.trim()
      const result = await patch({
        orgProviderKeys: {
          ...keys,
          "gemini-tts": trimmed || undefined,
        },
      })
      if (result.kind === "blocked" || result.kind === "forbidden") {
        setSubmitError("Only org maintainers and owners can set org-level API keys.")
      } else if (result.kind === "error") {
        setSubmitError(result.message ?? "Save failed")
      }
    },
  })

  useEffect(() => {
    form.setFieldValue("geminiKey", currentGeminiKey)
  }, [currentGeminiKey, form])

  if (!hasFetched) {
    return (
      <SettingsGroup label={t("settings.providerKeys.groupLabel")}>
        <SettingsRow label={t("settings.providerKeys.geminiTtsLabel")} block>
          <div className="flex items-center text-muted-foreground">
            <Spinner className="size-3.5" />
          </div>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup label={t("settings.providerKeys.groupLabel")}>
      {!canEditOrgKeys && (
        <div className="px-5 py-4 text-xs text-muted-foreground">
          {t("settings.providerKeys.restrictedNotice")}
        </div>
      )}
      <SettingsRow
        label={t("settings.providerKeys.geminiTtsLabel")}
        description={t("settings.providerKeys.geminiTtsDescription")}
        block
      >
        <form
          id="org-provider-form"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field
              name="geminiKey"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <RevealableInput
                      id="org-gemini-tts-key"
                      revealKind="key"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder={canEditOrgKeys ? "Paste Gemini API key…" : currentGeminiKey ? "(set by org admin)" : "(not set)"}
                      readOnly={!canEditOrgKeys}
                      aria-invalid={invalid}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          </FieldGroup>

          {canEditOrgKeys && (
            <div className="flex gap-2">
              <Button type="submit" form="org-provider-form">
                {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
                {form.state.isSubmitting ? "Saving…" : "Save key"}
              </Button>
              {currentGeminiKey && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => form.setFieldValue("geminiKey", "")}
                >
                  {t("common.clear")}
                </Button>
              )}
            </div>
          )}
          {submitError && (
            <FieldError className="text-xs">{submitError}</FieldError>
          )}
        </form>
      </SettingsRow>
    </SettingsGroup>
  )
}
