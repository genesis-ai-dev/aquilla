/**
 * AddConceptPopover — source-selection "Add to terminology" form.
 *
 * Opens next to the selection toolbar (not a modal). Pre-fills the highlighted
 * source term, lets the user edit it and optionally add a rendering. AQU-1271:
 * when the caller passes the open file's cells it also previews what the
 * matcher will hit — a live count plus the discovered surface forms as
 * toggleable chips — with the matching options (marks, affixes, case) behind
 * one disclosure. Save progress lives in a toast owned by the caller — this
 * popover closes as soon as submit is accepted.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react"
import { useForm, useStore } from "@tanstack/react-form"
import { ChevronRight } from "lucide-react"
import { z } from "zod"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { CellStore, readAtVersion, useCellStoreVersion } from "@/hooks/useActiveCellStore"
import { DiscoveredFormsChips } from "@/components/terminology/DiscoveredFormsChips"
import { MatchOptionsFields } from "@/components/terminology/MatchOptionsFields"
import { countConceptOccurrences, discoverForms } from "@/lib/terminology/discover-forms"
import { hasCombiningMarks, pruneMatch, resolveMatchOptions } from "@/lib/terminology/match-options"
import type { ConceptDraft, TermMatchingSettings, TermMatchOptions } from "@/lib/terminology/types"

/**
 * Stand-in for a caller that passes no store. `useCellStoreVersion` subscribes
 * and so cannot be called conditionally; an empty real store is cheaper and
 * more honest than a hand-rolled fake of the interface.
 */
const EMPTY_CELL_STORE = new CellStore()

const formSchema = z.object({
  term: requiredString("Source term"),
  rendering: z.string(),
  caseInsensitive: z.boolean(),
  approve: z.boolean(),
  match: z.object({
    foldMarks: z.boolean().optional(),
    affixes: z.boolean().optional(),
    forms: z.array(z.string()).optional(),
    excludedForms: z.array(z.string()).optional(),
  }),
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
  /**
   * The open file's cell store, previewed against while the popover is open.
   * Absent = no preview line and no discovered-form chips — the form still
   * works, it just cannot say what the term will hit.
   *
   * The STORE, not a cells array, and that is load-bearing: this component
   * subscribes to it directly, so a commit anywhere in the file re-renders the
   * open popover and nothing else. Handing rows a cells array (or a getter)
   * instead left the preview on whatever snapshot the memoized row last
   * rendered with.
   */
  cellStore?: CellStore
  /** Project affix inventory + fold defaults feeding the preview. */
  termMatching?: TermMatchingSettings
  /** Open project settings so the user can configure prefixes/suffixes. */
  onSetUpAffixes?: () => void
  onConfirm: (draft: ConceptDraft) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function AddConceptPopover({
  sourceTerm,
  blockedReason,
  canApprove = false,
  cellStore,
  termMatching,
  onSetUpAffixes,
  onConfirm,
  onOpenChange,
  children,
}: AddConceptPopoverProps) {
  const { t } = useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const blocked = !!blockedReason
  // Snapshot of the source term taken when the popover opens. Opening focuses
  // the input, which collapses the browser selection; the parent then passes
  // sourceTerm="" and must not wipe this seed.
  const seededTermRef = useRef("")

  const form = useForm({
    defaultValues: {
      term: sourceTerm,
      rendering: "",
      caseInsensitive: true,
      approve: canApprove,
      match: {} as TermMatchOptions,
    },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      if (blocked) return
      const rendering = value.rendering.trim()
      // Only what the user actually touched is persisted; an untouched form
      // leaves `match` off entirely so the concept keeps live defaults.
      const match = pruneMatch(value.match)
      setOpen(false)
      onOpenChange?.(false)
      void onConfirm({
        sourceTerm: value.term.trim(),
        ...(rendering ? { rendering } : {}),
        ...(value.caseInsensitive ? {} : { caseSensitive: true }),
        ...(match ? { match } : {}),
        // Never send `approve: true` from a user who cannot approve, whatever
        // the form field says — the server would refuse it, and asking for
        // something guaranteed to fail produces a confusing error instead of
        // the suggestion the user actually wanted.
        approve: canApprove && value.approve,
      })
    },
  })

  // Live matcher preview (AQU-1271). These must recompute on every keystroke
  // and every option toggle, so they read the form STORE — `form.state.values`
  // during render is a snapshot React never re-runs us for.
  const values = useStore(form.store, (s) => s.values)
  const term = values.term
  const match = values.match
  const caseSensitive = !values.caseInsensitive
  const previewConcept = useMemo(() => ({ sourceTerm: term, match, caseSensitive }), [term, match, caseSensitive])
  const resolved = useMemo(() => resolveMatchOptions(previewConcept, termMatching), [previewConcept, termMatching])
  // Gated on `open`: the toolbar mounts this popover the moment source text is
  // selected, and each of these walks every cell in the file. Nothing is shown
  // until the user actually opens the form, so nothing is scanned until then.
  const storeVersion = useCellStoreVersion(cellStore ?? EMPTY_CELL_STORE)
  const cells = useMemo(
    () => (open && cellStore ? readAtVersion(storeVersion, () => cellStore.getAllSummaries()) : undefined),
    [open, cellStore, storeVersion],
  )
  const forms = useMemo(
    () => (cells ? discoverForms(cells, previewConcept, termMatching) : []),
    [cells, previewConcept, termMatching],
  )
  const count = useMemo(
    () => (cells ? countConceptOccurrences(cells, previewConcept, termMatching) : 0),
    [cells, previewConcept, termMatching],
  )
  // Offer the fold-marks toggle only where marks actually exist — on plain
  // Latin text it is a checkbox that can never change an answer.
  const showFoldMarks = useMemo(
    () => hasCombiningMarks(term) || (cells?.some((c) => hasCombiningMarks(c.original)) ?? false),
    [term, cells],
  )
  const hasAffixInventory = resolved.prefixes.length > 0 || resolved.suffixes.length > 0

  const toggleExclude = (surface: string, excluded: boolean) => {
    const current = form.getFieldValue("match")
    const currentExcluded = current.excludedForms ?? []
    const next = excluded
      ? [...new Set([...currentExcluded, surface])]
      : currentExcluded.filter((f) => f !== surface)
    form.setFieldValue("match", {
      ...current,
      ...(next.length > 0 ? { excludedForms: next } : { excludedForms: undefined }),
    })
  }

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
    form.setFieldValue("match", {})
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
        form.setFieldValue("match", {})
      }
    } else {
      seededTermRef.current = ""
      setOptionsOpen(false)
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
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("terminology.match.wildcardHint")}
            </p>
            {cells && (
              <div className="grid gap-1.5">
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("terminology.match.previewCount", { count })}
                </p>
                <DiscoveredFormsChips forms={forms} disabled={blocked} onToggleExclude={toggleExclude} />
              </div>
            )}
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
            {/* AQU-1271: every "how should this term match" toggle — case,
                marks, affixes — lives behind one disclosure. Defaults are
                resolved from the project and the script, so the common case
                never opens this. */}
            <div className="grid gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="justify-start px-0 text-xs font-normal text-muted-foreground"
                aria-expanded={optionsOpen}
                onClick={() => setOptionsOpen((v) => !v)}
              >
                <ChevronRight className={optionsOpen ? "size-3 rotate-90" : "size-3"} aria-hidden />
                {t("terminology.match.optionsLabel")}
              </Button>
              {optionsOpen && (
                <MatchOptionsFields
                  value={match}
                  resolved={resolved}
                  showFoldMarks={showFoldMarks}
                  hasAffixInventory={hasAffixInventory}
                  caseSensitive={caseSensitive}
                  disabled={blocked}
                  idPrefix={id}
                  onChange={(next) => form.setFieldValue("match", next)}
                  onCaseSensitiveChange={(v) => form.setFieldValue("caseInsensitive", !v)}
                  onSetUpAffixes={onSetUpAffixes}
                />
              )}
            </div>
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
