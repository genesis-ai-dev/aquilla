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

const formSchema = z.object({
  name: requiredString("Project title"),
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
        setSubmitError(err instanceof Error ? err.message : "Failed to create project.")
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
          <h2 className="text-2xl font-semibold">Sign in to create a project</h2>
          <p className="text-sm text-muted-foreground">
            Projects are stored on the server. You need to be signed in so the
            project is accessible on all your devices and won't 403 when you
            open it.
          </p>
        </div>
        <Button variant="outline" size="lg" className="w-full" onClick={onBack}>
          ← Back to sign in
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={onSkip}>
          Do this later
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-2xl font-semibold">Create your first project</h2>
        <p className="text-sm text-muted-foreground">
          You can import files and invite collaborators after setup.
        </p>
      </div>
      <form
        id="project-step-form"
        autoComplete="off"
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
                  <FieldLabel htmlFor="proj-title">Project title</FieldLabel>
                  <Input
                    id="proj-title"
                    // Avoid DOM name="name" — Chrome contact autofill heuristic.
                    name="aquilla-project-title"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="My Translation Project"
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
                  <FieldLabel htmlFor="src-lang">Source language</FieldLabel>
                  <Input
                    id="src-lang"
                    name="aquilla-project-source-language"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="English"
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
                  <FieldLabel htmlFor="tgt-lang">Target language</FieldLabel>
                  <Input
                    id="tgt-lang"
                    name="aquilla-project-target-language"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="French"
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
          {form.state.isSubmitting ? "Creating…" : "Create Project"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={onSkip}
          disabled={form.state.isSubmitting}
        >
          Do this later
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
