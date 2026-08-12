import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { createOrg, createOrgInvite } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import posthog from "@/lib/posthog"
import { ORG_CREATED, INVITE_SENT } from "@/lib/event-names"
import { ChevronLeft } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

const formSchema = z.object({
  name: requiredString("Organization name"),
  emails: optionalString,
})

/**
 * Team-onboarding step: name the organization and (optionally) invite the first
 * collaborators by email in the same breath — embedding invitations into setup
 * is the single highest-signal predictor of team activation. Invites are
 * best-effort; a failed one never blocks org creation. On success the new org
 * becomes active so the following ProjectStep creates the first project inside
 * it.
 */
export function OrgStep({
  onCreated,
  onBack,
}: {
  onCreated: (orgId: number) => void
  onBack: () => void
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const { refresh, setActiveOrg } = useActiveOrg()
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { name: "", emails: "" },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      if (!session?.jwt) {
        setSubmitError(t("onboarding.step.org.signInRequired"))
        return
      }
      try {
        const org = await createOrg(session.jwt, value.name.trim())
        posthog.capture(ORG_CREATED, { org_id: org.id, source: "onboarding" })

        const list = value.emails
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
        for (const email of list) {
          try {
            await createOrgInvite(session.jwt, org.id, { email })
            posthog.capture(INVITE_SENT, {
              scope: "org",
              org_id: org.id,
              has_email: true,
              source: "onboarding",
            })
          } catch {
            /* skip this invite; keep going */
          }
        }

        await refresh()
        setActiveOrg(org.id)
        onCreated(org.id)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : t("onboarding.step.org.createFailed"))
      }
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-2xl font-semibold">{t("onboarding.step.org.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.step.org.description")}
        </p>
      </div>
      <form
        id="org-step-form"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup>
          <form.Field
            name="name"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="org-name">{t("onboarding.step.org.nameLabel")}</FieldLabel>
                  <Input
                    id="org-name"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("onboarding.step.org.namePlaceholder")}
                    aria-invalid={invalid}
                    autoFocus
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="emails"
            children={(field) => (
              <Field>
                <FieldLabel htmlFor="org-emails">{t("onboarding.step.org.inviteLabel")}</FieldLabel>
                <Input
                  id="org-emails"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="alex@example.com, sam@example.com"
                />
                <FieldDescription>
                  {t("onboarding.step.org.inviteDescription")}
                </FieldDescription>
              </Field>
            )}
          />
        </FieldGroup>
        {submitError && (
          <FieldError role="alert">{submitError}</FieldError>
        )}
        <Button type="submit" form="org-step-form" size="lg" className="w-full">
          {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
          {form.state.isSubmitting ? t("onboarding.common.creating") : t("onboarding.step.org.createButton")}
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        {t("common.back")}
      </Button>
    </div>
  )
}
