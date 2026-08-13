import { useEffect } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createOrg } from "@/lib/frontier/orgs"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { useSubmitError } from "@/lib/forms/submit-error"
import posthog from "@/lib/posthog"
import { ORG_CREATED } from "@/lib/event-names"
import { useT } from "@/lib/i18n/I18nProvider"

interface OrgCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (orgId: number) => void
}

export function OrgCreateDialog({ open, onOpenChange, onCreated }: OrgCreateDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const formSchema = z.object({
    name: z.string().refine((val) => val.trim().length > 0, {
      message: t("org.createDialog.nameRequiredError"),
    }),
  })

  const form = useForm({
    defaultValues: { name: "" },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      if (!jwt) return
      clearSubmitError()
      try {
        const org = await createOrg(jwt, value.name.trim())
        posthog.capture(ORG_CREATED, { org_id: org.id })
        onCreated(org.id)
        onOpenChange(false)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : t("org.createDialog.genericError"))
      }
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset()
    clearSubmitError()
  }, [open, form, clearSubmitError])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("org.createDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("org.createDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          id="org-create-form"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field
              name="name"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <FieldLabel htmlFor="org-create-name">{t("org.createDialog.nameLabel")}</FieldLabel>
                    <Input
                      id="org-create-name"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder={t("org.createDialog.namePlaceholder")}
                      aria-invalid={invalid}
                      autoFocus
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          </FieldGroup>
          {submitError && (
            <FieldError role="alert" className="mt-3">
              {submitError}
            </FieldError>
          )}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="org-create-form">
              {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
              {form.state.isSubmitting ? t("common.creating") : t("org.createDialog.title")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
