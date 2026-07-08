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
import { renameOrg } from "@/lib/frontier/orgs"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"

const formSchema = z.object({
  name: requiredString("Organization name"),
})

interface OrgRenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: number
  currentName: string
  onRenamed?: () => unknown
}

export function OrgRenameDialog({
  open,
  onOpenChange,
  orgId,
  currentName,
  onRenamed,
}: OrgRenameDialogProps) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: { name: currentName },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      if (!jwt) return
      clearSubmitError()
      try {
        await renameOrg(jwt, orgId, value.name.trim())
        await onRenamed?.()
        onOpenChange(false)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Couldn't rename your organization.")
      }
    },
  })

  // Re-seed only when the dialog opens or the org name prop changes — not on
  // every parent re-render (unstable deps here were wiping in-progress edits).
  useEffect(() => {
    if (!open) return
    form.reset()
    form.setFieldValue("name", currentName)
    clearSubmitError()
  }, [open, currentName, form, clearSubmitError])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename organization</DialogTitle>
          <DialogDescription>
            This name is shown across the workspace — in the sidebar, settings, and member lists.
          </DialogDescription>
        </DialogHeader>
        <form
          id="org-rename-form"
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
                    <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
                    <Input
                      id="org-name"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid}
                      autoFocus
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          </FieldGroup>
          {submitError ? <FieldError role="alert" className="mt-3">{submitError}</FieldError> : null}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="org-rename-form">
              {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
              {form.state.isSubmitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
