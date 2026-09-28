import { useEffect, useMemo, useState, type SyntheticEvent } from "react"
import { Check, CheckCheck, Circle, Trash2 } from "lucide-react"
import type { EditValidationSummary, ValidationStatus } from "@/hooks/useCells"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"

interface TargetValidationControlProps {
  cellRef: string
  hasContent: boolean
  validationStatus: ValidationStatus
  activeValidators: string[]
  validationHistory: EditValidationSummary[]
  currentUsername: string
  validationRequirement: number
  canValidate: boolean
  canValidateThisCell: boolean
  onValidationChange: (validated: boolean) => unknown
}

type PreventableReactEvent<T> = SyntheticEvent<T> & {
  preventBaseUIHandler?: () => void
}

function ValidationHistoryTimeline({
  entries,
  currentUsername,
}: {
  entries: EditValidationSummary[]
  currentUsername: string
}) {
  const { t } = useI18n()
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const historical = entries.slice(0, -1).reverse()
  if (historical.length === 0) return null

  return (
    <>
      <div className="my-1 h-px bg-border" />
      <div className="mb-1 px-1 text-xs text-muted-foreground">{t("editor.validation.history")}</div>
      <ul className="space-y-0.5">
        {historical.map((entry, index) => {
          const snippet = typeof entry.value === "string"
            ? (entry.value.length > 40 ? `${entry.value.slice(0, 40)}…` : entry.value)
            : ""
          const authors = entry.authors.join(", ")
          const expanded = expandedIdx === index
          return (
            <li key={`${entry.timestamp}-${index}`} className="rounded text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-1 py-1 text-start hover:bg-muted/50"
                onClick={() => setExpandedIdx(expanded ? null : index)}
              >
                <span className="truncate">
                  <span className="text-muted-foreground">
                    <DateTooltip value={entry.timestamp} label={t("common.date.edited")} />
                    {" · "}
                  </span>
                  <span>{authors}</span>
                </span>
              </button>
              {snippet && (
                <div className="truncate px-1 pb-1 text-[11px] italic text-muted-foreground/80">“{snippet}”</div>
              )}
              {expanded && (
                <ul className="mb-1 ms-1 space-y-0.5 border-s border-border/50 ps-2">
                  {entry.validatorsAll.length === 0 ? (
                    <li className="px-1 py-0.5 text-[11px] text-muted-foreground/60">{t("editor.validation.noValidatorsOnState")}</li>
                  ) : entry.validatorsAll.map((validator) => (
                    <li
                      key={validator.username}
                      className={cn(
                        "flex items-center gap-1 px-1 py-0.5 text-[11px]",
                        validator.isDeleted && "text-muted-foreground/50 line-through",
                      )}
                    >
                      <span>{validator.username}{validator.username === currentUsername ? ` ${t("editor.validation.you")}` : ""}</span>
                      <span className="ms-auto text-muted-foreground/60">
                        <DateTooltip value={validator.updatedTimestamp} label={t("org.orgHome.table.validatedHeaderLabel")} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * The editor's real target-cell validation control. It owns the optimistic
 * toggle and validator popover so every presentation behaves identically.
 */
export function TargetValidationControl({
  cellRef,
  hasContent,
  validationStatus,
  activeValidators,
  validationHistory,
  currentUsername,
  validationRequirement,
  canValidate,
  canValidateThisCell,
  onValidationChange,
}: TargetValidationControlProps) {
  const { t } = useI18n()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [pendingValidation, setPendingValidation] = useState<{
    value: boolean
    authoritativeAtRequest: boolean
  } | null>(null)
  const authoritativeSelfValidated = activeValidators.includes(currentUsername)
  useEffect(() => {
    if (pendingValidation && authoritativeSelfValidated === pendingValidation.value) {
      setPendingValidation(null)
    }
  }, [authoritativeSelfValidated, pendingValidation])
  const optimisticSelfValidation = pendingValidation
    && authoritativeSelfValidated === pendingValidation.authoritativeAtRequest
    ? pendingValidation.value
    : null

  const isSelfValidated = optimisticSelfValidation ?? authoritativeSelfValidated
  const displayedValidators = useMemo(() => {
    if (optimisticSelfValidation === null) return activeValidators
    if (optimisticSelfValidation) {
      return activeValidators.includes(currentUsername)
        ? activeValidators
        : [...activeValidators, currentUsername]
    }
    return activeValidators.filter((validator) => validator !== currentUsername)
  }, [activeValidators, currentUsername, optimisticSelfValidation])

  const state = optimisticSelfValidation === true
    ? displayedValidators.length >= validationRequirement ? "full-self" : "self"
    : optimisticSelfValidation === false
      ? displayedValidators.length >= validationRequirement ? "full-others" : displayedValidators.length > 0 ? "others" : "none"
      : validationStatus
  const hasValidatorInfo = displayedValidators.length > 0 || validationHistory.length > 1
  const ValidationIcon = state === "full-self" || state === "full-others" || state === "full"
    ? CheckCheck
    : state === "self" ? Check : Circle
  const validationColorClass = state === "full-self" || state === "full-others" || state === "full" || state === "self"
    ? "text-green-500"
    : state === "others" ? "text-muted-foreground/60" : "text-muted-foreground/30"
  const tooltip = canValidateThisCell
    ? t("editor.validation.notValidatedTooltip")
    : canValidate ? t("editor.validation.outOfScopeTooltip") : t("editor.validation.unavailableTooltip")
  // Why the viewer cannot add a vote, at the foot of the "Text validated by" list —
  // the same place the audio control puts it, so a blocked reason is never
  // hidden just because somebody else voted first.
  const blockedNote = canValidateThisCell || isSelfValidated ? null : tooltip

  const changeValidation = (validated: boolean) => {
    setPendingValidation({ value: validated, authoritativeAtRequest: authoritativeSelfValidated })
    void Promise.resolve(onValidationChange(validated)).then((accepted) => {
      if (accepted === false) setPendingValidation(null)
    }).catch(() => setPendingValidation(null))
  }

  function handleOpenChange(nextOpen: boolean, details: { reason: string; cancel(): void }) {
    if (!nextOpen) {
      setPopoverOpen(false)
      return
    }
    if (details.reason === "trigger-press" || details.reason === "keyboard") {
      if (canValidateThisCell && !isSelfValidated) {
        details.cancel()
        return
      }
      setPopoverOpen(true)
      return
    }
    if (details.reason === "trigger-hover" && !hasValidatorInfo) {
      details.cancel()
      return
    }
    setPopoverOpen(true)
  }

  const renderButton = (onClick?: () => void) => (
    <button
      type="button"
      data-showcase="cell.validation"
      aria-pressed={isSelfValidated}
      // No "click to…" when a click would do nothing — the audio control's
      // rule. A viewer outside the lane used to be told to click a dead button.
      aria-label={
        isSelfValidated
          ? t("editor.validation.ariaValidated", { ref: cellRef })
          : state === "full-others" || state === "others"
            ? canValidateThisCell
              ? t("editor.validation.ariaValidatedByOthers", { ref: cellRef })
              : t("editor.validation.ariaValidatedByOthersNoAction", { ref: cellRef })
            : canValidateThisCell
              ? t("editor.validation.ariaNotValidated", { ref: cellRef })
              : t("editor.validation.ariaNotValidatedNoAction", { ref: cellRef })
      }
      onClick={(event) => {
        if (!onClick) return
        onClick()
        ;(event as PreventableReactEvent<HTMLButtonElement>).preventBaseUIHandler?.()
      }}
      onKeyDown={(event) => {
        if (!onClick || (event.key !== " " && event.key !== "Enter")) return
        event.preventDefault()
        event.stopPropagation()
        onClick()
        ;(event as PreventableReactEvent<HTMLButtonElement>).preventBaseUIHandler?.()
      }}
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded-lg transition-[transform,color,background-color] duration-150 ease-out",
        "active:scale-[0.88] aria-disabled:cursor-not-allowed aria-disabled:opacity-30 hover:bg-muted/80",
        validationColorClass,
        canValidateThisCell && (state === "none" || state === "others" || state === "full-others") && "hover:text-green-500",
      )}
      // aria-disabled, NOT `disabled`: a disabled button fires no pointer
      // events, so the tooltip or list explaining WHY this viewer cannot
      // validate never opened (Sam, 2026-09-23 — the AQU-1068 trap, which the
      // audio control beside it already avoids). A press does nothing because
      // no handler is wired when the viewer cannot vote.
      aria-disabled={!canValidateThisCell || undefined}
    >
      <ValidationIcon
        className="relative h-3.5 w-3.5"
        strokeWidth={2.5}
        {...(state === "others" ? { fill: "currentColor" } : {})}
      />
    </button>
  )

  return (
    <div data-testid="validation-gutter" className="flex w-6 shrink-0 items-start pt-1">
      {hasContent ? (
        hasValidatorInfo ? (
          <Popover key="list" open={popoverOpen} onOpenChange={handleOpenChange}>
            <PopoverTrigger
              openOnHover
              delay={400}
              closeDelay={100}
              render={renderButton(canValidateThisCell && !isSelfValidated
                ? () => changeValidation(true)
                : undefined)}
            />
            {state !== "empty" && (
              <PopoverContent side="right" align="start" className="w-72 rounded-xl p-2">
                <ul className="space-y-0.5">
                  <li className="mb-1 px-1 text-xs text-muted-foreground">{t("editor.validation.validatedBy")}</li>
                  {displayedValidators.length === 0 ? (
                    <li className="px-1 py-1 text-xs text-muted-foreground">{t("editor.validation.noActiveValidators")}</li>
                  ) : displayedValidators.map((validator) => (
                    <li key={validator} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                      <span className="truncate">{validator}{validator === currentUsername ? " (you)" : ""}</span>
                      {validator === currentUsername && canValidate && (
                        <AppTooltip content={t("editor.validation.removeYours")}>
                          <button
                            type="button"
                            aria-label={t("editor.validation.removeYours")}
                            className="shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              changeValidation(false)
                              setPopoverOpen(false)
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </AppTooltip>
                      )}
                    </li>
                  ))}
                </ul>
                {validationHistory.length > 0 && (
                  <ValidationHistoryTimeline entries={validationHistory} currentUsername={currentUsername} />
                )}
                {blockedNote && (
                  <div data-testid="validation-blocked-note" className="mt-1 border-t border-border px-1 pt-1.5 text-[11px] text-muted-foreground">
                    {blockedNote}
                  </div>
                )}
              </PopoverContent>
            )}
          </Popover>
        ) : (
          <AppTooltip key="tooltip" content={tooltip}>
            {renderButton(canValidateThisCell && !isSelfValidated
              ? () => changeValidation(true)
              : undefined)}
          </AppTooltip>
        )
      ) : (
        // Nothing to validate: a line with no text. Drawn FADED rather than
        // left blank (Sam, 2026-09-23), so both gutter columns read full on
        // every row and "nothing here" looks different from "not validated
        // yet". A span, not a disabled button — it is no tab stop, and unlike a
        // disabled button it still takes the hover that explains itself.
        // Keyed, like every branch here: React would otherwise reuse this
        // tooltip for the real button when text arrives, and Base UI's hover
        // listeners stay on the discarded span (see AudioValidationControl).
        <AppTooltip key="unavailable" content={t("editor.validation.noContentTooltip")}>
          <span
            role="img"
            data-testid="validation-unavailable"
            aria-label={t("editor.validation.ariaNoContent", { ref: cellRef })}
            className="flex h-6 w-6 cursor-default items-center justify-center text-muted-foreground/30 opacity-40"
          >
            <Circle className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </AppTooltip>
      )}
    </div>
  )
}
