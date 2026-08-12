import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { createProject as createLocalProject } from "@/lib/store/project-index"
import { createRemoteProject } from "@/lib/frontier/members"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ChevronLeft } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

const formSchema = z.object({
  name: requiredString("Project name"),
  sourceLanguage: requiredString("Source language"),
  targetLanguage: requiredString("Target language"),
})

export function ProjectStep({
  displayName,
  onCreated,
  onBack,
  onSkip,
  orgId,
}: {
  displayName: string
  onCreated: (p: ProjectRecord) => void
  onBack: () => void
  onSkip: () => void
  /** When set (Team onboarding), the project is created inside this org. */
  orgId?: number
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { name: "", sourceLanguage: "", targetLanguage: "" },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      if (!session?.jwt) return
      clearSubmitError()
      try {
        const created = await createRemoteProject(
          { id: uuid(), name: value.name.trim() },
          session.jwt,
          orgId,
        )
        const project: ProjectRecord = {
          id: created.id,
          name: value.name.trim(),
          sourceLanguage: value.sourceLanguage.trim(),
          targetLanguage: value.targetLanguage.trim(),
          createdAt: new Date().toISOString(),
          files: [],
          members: [{ userId: session.username, role: "owner" }],
          username: displayName || session.username,
          syncRole: {
            level: created.role.level,
            name: created.role.name,
            source: created.role.source as "override" | "creator" | "org",
            fetchedAt: new Date().toISOString(),
          },
        }
        await createLocalProject(project)
        onCreated(project)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : t("onboarding.step.project.createFailed"))
      }
    },
  })

  // Guard: project creation requires a server session (AD-3 projects are
  // server-only reads; a local-only project will 403 the moment the user
  // opens it after signing in). Mirror ProjectCreateDialog which rejects
  // with "You need to be signed in." on the Dashboard. Show an inline
  // sign-in prompt here rather than silently producing a broken project.
  if (!session?.jwt) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 text-center">
          <h2 className="text-2xl font-semibold">{t("onboarding.step.project.signInHeading")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("onboarding.step.project.signInDescription")}
          </p>
        </div>
        <Button variant="outline" size="lg" className="w-full" onClick={onBack}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          {t("onboarding.step.project.backToSignIn")}
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={onSkip}>
          {t("onboarding.step.project.doThisLater")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-2xl font-semibold">{t("onboarding.step.project.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.step.project.description")}
        </p>
      </div>
      <form
        id="project-step-form"
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
                  <FieldLabel htmlFor="proj-name">{t("onboarding.step.project.nameLabel")}</FieldLabel>
                  <Input
                    id="proj-name"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("onboarding.step.project.namePlaceholder")}
                    aria-invalid={invalid}
                    autoFocus
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="sourceLanguage"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="src-lang">{t("onboarding.step.project.sourceLanguageLabel")}</FieldLabel>
                  <Input
                    id="src-lang"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("onboarding.step.project.sourceLanguagePlaceholder")}
                    aria-invalid={invalid}
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="targetLanguage"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="tgt-lang">{t("autopilot.inspector.details.targetLanguage")}</FieldLabel>
                  <Input
                    id="tgt-lang"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("onboarding.step.project.targetLanguagePlaceholder")}
                    aria-invalid={invalid}
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
        </FieldGroup>
        {submitError && (
          <FieldError role="alert">{submitError}</FieldError>
        )}
        <Button type="submit" form="project-step-form" size="lg" className="w-full">
          {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
          {form.state.isSubmitting ? t("onboarding.common.creating") : t("onboarding.step.project.createButton")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={onSkip}
          disabled={form.state.isSubmitting}
        >
          {t("onboarding.step.project.doThisLater")}
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        {t("common.back")}
      </Button>
    </div>
  )
}
