/**
 * AddConceptPopover — source-selection "Add to terminology" form.
 *
 * Opens next to the selection toolbar (not a modal). Pre-fills the highlighted
 * source term, lets the user edit it, optionally add a rendering, and toggle
 * case-insensitive matching. Save progress lives in a toast owned by the
 * caller — this popover closes as soon as submit is accepted.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { ConceptDraft } from "@/lib/terminology/types"

const formSchema = z.object({
  term: requiredString("Source term"),
  rendering: z.string(),
  caseInsensitive: z.boolean(),
  approve: z.boolean(),
})

export interface AddConceptPopoverProps {
  sourceTerm: string
  /** Non-null when the current user cannot write terminology AT ALL. */
  blockedReason?: string | null
  /**
   * May this user APPROVE a term (add it enforced), as opposed to merely
   * suggesting one? Defaults to false — the restrictive answer — so a caller
   * that forgets to pass it produces suggestions rather than silently writing
   * enforced terminology the user has no authority for.
   */
  canApprove?: boolean
  onConfirm: (draft: ConceptDraft) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function AddConceptPopover({
  sourceTerm,
  blockedReason,
  canApprove = false,
  onConfirm,
  onOpenChange,
  children,
}: AddConceptPopoverProps) {
  const { t } = useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const blocked = !!blockedReason
  // Snapshot of the source term taken when the popover opens. Opening focuses
  // the input, which collapses the browser selection; the parent then passes
  // sourceTerm="" and must not wipe this seed.
  const seededTermRef = useRef("")

  const form = useForm({
    defaultValues: { term: sourceTerm, rendering: "", caseInsensitive: true, approve: canApprove },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      if (blocked) return
      const rendering = value.rendering.trim()
      setOpen(false)
      onOpenChange?.(false)
      void onConfirm({
        sourceTerm: value.term.trim(),
        ...(rendering ? { rendering } : {}),
        ...(value.caseInsensitive ? {} : { caseSensitive: true }),
        // Never send `approve: true` from a user who cannot approve, whatever
        // the form field says — the server would refuse it, and asking for
        // something guaranteed to fail produces a confusing error instead of
        // the suggestion the user actually wanted.
        approve: canApprove && value.approve,
      })
    },
  })

  useEffect(() => {
    if (!open) {
      seededTermRef.current = ""
      return
    }
    if (seededTermRef.current) return
    const seed = sourceTerm.trim()
    if (!seed) return
    seededTermRef.current = seed
    form.reset()
    form.setFieldValue("term", seed)
    form.setFieldValue("rendering", "")
    form.setFieldValue("caseInsensitive", true)
    form.setFieldValue("approve", canApprove)
  }, [open, sourceTerm, form, canApprove])

  function handleOpenChange(next: boolean) {
    if (next) {
      const seed = sourceTerm.trim()
      if (seed) {
        seededTermRef.current = seed
        form.reset()
        form.setFieldValue("term", seed)
        form.setFieldValue("rendering", "")
        form.setFieldValue("caseInsensitive", true)
        form.setFieldValue("approve", canApprove)
      }
    } else {
      seededTermRef.current = ""
    }
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={children as ReactElement} />
      <PopoverContent align="end" side="bottom" className="w-80 gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>{t("terminology.addConcept.title")}</PopoverTitle>
        </PopoverHeader>

        <form
          id={`${id}-form`}
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup className="gap-3">
            <form.Field
              name="term"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <FieldLabel htmlFor={`${id}-term`} className="text-xs font-medium">
                      {t("terminology.editor.sourceTermLabel")}
                    </FieldLabel>
                    <Input
                      id={`${id}-term`}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder={t("terminology.addConcept.sourceTermPlaceholder")}
                      aria-label={t("terminology.addConcept.sourceTermAriaLabel")}
                      aria-invalid={invalid}
                      disabled={blocked}
                      autoFocus={!blocked}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
            <form.Field
              name="rendering"
              children={(field) => (
                <Field>
                  <FieldLabel htmlFor={`${id}-rendering`} className="text-xs font-medium">
                    {t("terminology.editor.renderingLabel")}
                  </FieldLabel>
                  <Input
                    id={`${id}-rendering`}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("terminology.addConcept.renderingPlaceholder")}
                    aria-label={t("terminology.addConcept.renderingAriaLabel")}
                    disabled={blocked}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void form.handleSubmit()
                      }
                    }}
                  />
                </Field>
              )}
            />
            <form.Field
              name="approve"
              children={(field) => (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`${id}-approve`}
                    checked={field.state.value}
                    // Locked off below the org's termbase floor: a contributor
                    // may SUGGEST a term but not put it into force.
                    disabled={blocked || !canApprove}
                    onCheckedChange={(checked) => field.handleChange(checked === true)}
                  />
                  <div className="grid gap-0.5">
                    <FieldLabel htmlFor={`${id}-approve`} className="text-xs font-normal">
                      {t("terminology.addConcept.approveLabel")}
                    </FieldLabel>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {!canApprove
                        ? t("terminology.addConcept.approveNoPermissionHint")
                        : field.state.value
                          ? t("terminology.addConcept.approveEnforcedHint")
                          : t("terminology.addConcept.approveSuggestionHint")}
                    </p>
                  </div>
                </div>
              )}
            />
            {/* AQU-1006 follow-up: the demo's second complaint was "I added a
                term and no blot appeared". A concept with no rendering compiles
                to ZERO rules (compileConceptsToRules), so it can never
                highlight anything however it is approved. Say so at the moment
                the rendering box is left empty, rather than letting the user
                discover it by its absence. */}
            <form.Subscribe
              selector={(state) => [state.values.rendering, state.values.approve] as const}
              children={([rendering, approve]) =>
                approve && !rendering.trim() ? (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {t("terminology.addConcept.noRenderingNotEnforcedHint")}
                  </p>
                ) : null
              }
            />
            <form.Field
              name="caseInsensitive"
              children={(field) => (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-case-insensitive`}
                    checked={field.state.value}
                    disabled={blocked}
                    onCheckedChange={(checked) => field.handleChange(checked === true)}
                  />
                  <FieldLabel htmlFor={`${id}-case-insensitive`} className="text-xs font-normal">
                    {t("terminology.addConcept.caseInsensitiveLabel")}
                  </FieldLabel>
                </div>
              )}
            />
          </FieldGroup>
        </form>

        {blockedReason && (
          <p role="alert" className="text-sm text-destructive">
            {blockedReason}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            size="sm"
            aria-label={t("terminology.addConcept.createDraftAriaLabel")}
            disabled={blocked}
          >
            {t("terminology.editor.addTerm")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** @deprecated Use AddConceptPopover — kept as an alias for existing imports. */
export const AddConceptDialog = AddConceptPopover
