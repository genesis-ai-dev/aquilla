/**
 * AddConceptDialog — small confirm dialog for the "Add to termbase" action.
 *
 * Shown when the user selects source text and clicks "Add to termbase". It
 * pre-fills the selected term so the user can review (and optionally trim)
 * it before the draft concept is created.
 */

import { useEffect } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"

const formSchema = z.object({
  term: requiredString("Source term"),
})

interface AddConceptDialogProps {
  open: boolean
  sourceTerm: string
  onConfirm: (term: string) => void | Promise<void>
  onCancel: () => void
}

export function AddConceptDialog({
  open,
  sourceTerm,
  onConfirm,
  onCancel,
}: AddConceptDialogProps) {
  const form = useForm({
    defaultValues: { term: sourceTerm },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      await onConfirm(value.term.trim())
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset()
    form.setFieldValue("term", sourceTerm)
  }, [open, sourceTerm, form])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="add-concept-title" aria-describedby="add-concept-desc">
        <DialogHeader>
          <DialogTitle id="add-concept-title">Add to term base</DialogTitle>
          <DialogDescription id="add-concept-desc">
            Creates a draft concept with this source term. Add renderings and
            activate it from the Terminology page.
          </DialogDescription>
        </DialogHeader>

        <form
          id="add-concept-form"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field
              name="term"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <FieldLabel htmlFor="concept-term-input" className="text-xs font-medium">
                      Source term
                    </FieldLabel>
                    <Input
                      id="concept-term-input"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void form.handleSubmit()
                        }
                      }}
                      placeholder="Source term…"
                      aria-label="Source term for new concept"
                      aria-invalid={invalid}
                      autoFocus
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-concept-form"
            aria-label="Create draft concept"
          >
            {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
            {form.state.isSubmitting ? "Saving…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
