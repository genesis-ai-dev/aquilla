/**
 * AddConceptDialog — small confirm dialog for the "Add to termbase" action.
 *
 * Shown when the user selects source text and clicks "Add to termbase". It
 * pre-fills the selected term so the user can review (and optionally trim)
 * it before the draft concept is created.
 */

import { useEffect, useState } from "react"
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
  /** Non-null when the current user cannot write to the term base (below the
   *  Maintainer floor). The dialog opens blocked: input and Create draft are
   *  disabled and this reason is shown, but Cancel stays active so the user
   *  can dismiss it — instead of letting them type a draft doomed to reject. */
  blockedReason?: string | null
  onConfirm: (term: string) => void | Promise<void>
  onCancel: () => void
}

export function AddConceptDialog({
  open,
  sourceTerm,
  blockedReason,
  onConfirm,
  onCancel,
}: AddConceptDialogProps) {
  // AQU-754: onConfirm persists the concept and throws when the save is
  // rejected (below Maintainer, offline, conflict, 5xx). Surface that reason and
  // keep the dialog open instead of dismissing it as if the concept was saved.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const blocked = !!blockedReason

  const form = useForm({
    defaultValues: { term: sourceTerm },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      if (blocked) return
      setSubmitError(null)
      try {
        await onConfirm(value.term.trim())
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Couldn't add the concept — try again.")
      }
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset()
    form.setFieldValue("term", sourceTerm)
    setSubmitError(null)
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
                      disabled={blocked}
                      autoFocus={!blocked}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
          </FieldGroup>
        </form>

        {(blockedReason ?? submitError) && (
          <p role="alert" className="px-1 text-sm text-destructive">
            {blockedReason ?? submitError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {/* Subscribe rather than reading form.state.isSubmitting in render:
              that read is not reactive, so after a rejected save the button
              stayed stuck on "Saving…" (same trap as ProjectCreateDialog). */}
          <form.Subscribe
            selector={(state) => state.isSubmitting}
            children={(isSubmitting) => (
              <Button
                type="submit"
                form="add-concept-form"
                aria-label="Create draft concept"
                disabled={blocked || isSubmitting}
              >
                {isSubmitting && <Spinner data-icon="inline-start" />}
                {isSubmitting ? "Saving…" : "Create draft"}
              </Button>
            )}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
