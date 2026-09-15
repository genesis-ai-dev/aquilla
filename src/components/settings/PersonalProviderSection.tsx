import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel, OptionalMark } from "@/components/ui/field"
import { SettingsGroup } from "@/components/ui/page"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { t } from "@/lib/i18n/standalone"
import { customProviderNeedsKey } from "@/lib/completion/completion-service"
import {
  clearUserProviderOverride,
  getUserProviderOverride,
  setUserProviderOverride,
} from "@/lib/store/user-provider-override"

const formSchema = z.object({
  endpoint: requiredString("Endpoint URL"),
  model: optionalString,
  apiKey: optionalString,
}).superRefine((value, ctx) => {
  if (customProviderNeedsKey(value.endpoint) && !value.apiKey.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: t("projectSettings.advancedLlm.apiKeyRequiredError"),
    })
  }
})

/**
 * Advanced, opt-in: a personal AI provider default for this browser.
 * A project-level custom key beats it. Hidden behind a disclosure so the
 * default Settings view stays uncluttered for users on the happy path
 * (Frontier managed model + sign-in).
 */
export function PersonalProviderSection() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [hasOverride, setHasOverride] = useState(false)

  const form = useForm({
    defaultValues: {
      endpoint: "",
      model: "",
      apiKey: "",
    },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      setUserProviderOverride({
        endpoint: value.endpoint.trim(),
        model: value.model.trim() || undefined,
        apiKey: value.apiKey.trim() || undefined,
      })
      setHasOverride(true)
    },
  })

  useEffect(() => {
    const existing = getUserProviderOverride()
    if (existing) {
      form.setFieldValue("endpoint", existing.endpoint)
      form.setFieldValue("model", existing.model ?? "")
      form.setFieldValue("apiKey", existing.apiKey ?? "")
      setHasOverride(true)
      setOpen(true)
    }
  }, [form])

  function handleClear() {
    clearUserProviderOverride()
    form.reset()
    setHasOverride(false)
  }

  return (
    <SettingsGroup label={t("settings.personalProvider.groupLabel")}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-start gap-3 px-5 py-4 text-start hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset">
          {open ? (
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {t("settings.personalProvider.advancedToggleLabel")}
            </p>
            <p className="text-xs text-muted-foreground">
              {hasOverride
                ? "Active — default for projects without their own API key."
                : "Optional. Most users should leave this off and use Frontier."}
            </p>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <form
            id="personal-provider-form"
            className="flex flex-col gap-4 border-t px-5 pb-4 pt-4"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <p className="text-xs text-muted-foreground">
              {t("settings.personalProvider.description")}
            </p>

            <FieldGroup>
              <form.Field
                name="endpoint"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="prov-endpoint">
                        {t("projectSettings.advancedLlm.endpointLabel")}
                      </FieldLabel>
                      <Input
                        id="prov-endpoint"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="https://openrouter.ai/api/v1"
                        aria-invalid={invalid}
                        autoComplete="off"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        <RichMessage
                          k="settings.personalProvider.trailingPathHint"
                          values={{
                            v1Path: <code className="font-mono">/v1</code>,
                            // i18n-exempt literal API path, shown verbatim as syntax
                            chatCompletionsPath: <code className="font-mono">/chat/completions</code>,
                          }}
                        />
                      </p>
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />

              <form.Field
                name="model"
                children={(field) => (
                  <Field>
                    <FieldLabel htmlFor="prov-model">
                      {t("projectSettings.advancedLlm.modelLabel")} <OptionalMark />
                    </FieldLabel>
                    <Input
                      id="prov-model"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="gpt-4o-mini"
                      autoComplete="off"
                    />
                  </Field>
                )}
              />

              <form.Field
                name="apiKey"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="prov-key">
                        {t("projectSettings.field.apiKey")} <OptionalMark />
                      </FieldLabel>
                      <Input
                        id="prov-key"
                        name={field.name}
                        type="password"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder={t("settings.personalProvider.apiKeyPlaceholder")}
                        autoComplete="off"
                        aria-invalid={invalid}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        <RichMessage
                          k="settings.personalProvider.authHeaderHint"
                          values={{
                            // i18n-exempt literal HTTP header, shown verbatim as syntax
                            authHeader: <code className="font-mono">Authorization: Bearer …</code>,
                          }}
                        />
                      </p>
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
            </FieldGroup>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button type="submit" form="personal-provider-form">
                {hasOverride ? "Update override" : "Save override"}
              </Button>
              {hasOverride && (
                <Button type="button" variant="ghost" onClick={handleClear}>
                  {t("settings.personalProvider.removeOverride")}
                </Button>
              )}
            </div>
          </form>
        </CollapsibleContent>
      </Collapsible>
    </SettingsGroup>
  )
}
