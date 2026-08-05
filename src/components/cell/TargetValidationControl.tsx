import { useMemo, useState, type SyntheticEvent } from "react"
import { Check, CheckCheck, Circle, Trash2 } from "lucide-react"
import type { EditValidationSummary, ValidationStatus } from "@/hooks/useCells"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

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
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const historical = entries.slice(0, -1).reverse()
  if (historical.length === 0) return null

  return (
    <>
      <div className="my-1 h-px bg-border" />
      <div className="mb-1 px-1 text-xs text-muted-foreground">History</div>
      <ul className="space-y-0.5">
        {historical.map((entry, index) => {
          const snippet = typeof entry.value === "string"
            ? (entry.value.length > 40 ? `${entry.value.slice(0, 40)}…` : entry.value)
            : ""
          const date = new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          const authors = entry.authors.join(", ")
          const expanded = expandedIdx === index
          return (
            <li key={`${entry.timestamp}-${index}`} className="rounded text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left hover:bg-muted/50"
                onClick={() => setExpandedIdx(expanded ? null : index)}
              >
                <span className="truncate">
                  <span className="text-muted-foreground">{date} · </span>
                  <span>{authors}</span>
                </span>
              </button>
              {snippet && (
                <div className="truncate px-1 pb-1 text-[11px] italic text-muted-foreground/80">“{snippet}”</div>
              )}
              {expanded && (
                <ul className="mb-1 ml-1 space-y-0.5 border-l border-border/50 pl-2">
                  {entry.validatorsAll.length === 0 ? (
                    <li className="px-1 py-0.5 text-[11px] text-muted-foreground/60">No validators on this state</li>
                  ) : entry.validatorsAll.map((validator) => (
                    <li
                      key={validator.username}
                      className={cn(
                        "flex items-center gap-1 px-1 py-0.5 text-[11px]",
                        validator.isDeleted && "text-muted-foreground/50 line-through",
                      )}
                    >
                      <span>{validator.username}{validator.username === currentUsername ? " (you)" : ""}</span>
                      <span className="ml-auto text-muted-foreground/60">
                        {new Date(validator.updatedTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [pendingValidation, setPendingValidation] = useState<{
    value: boolean
    authoritativeAtRequest: boolean
  } | null>(null)
  const authoritativeSelfValidated = activeValidators.includes(currentUsername)
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
    ? "Not validated — click to validate"
    : canValidate ? "Outside your assigned files or lanes" : "Validation unavailable"

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
      aria-label={
        isSelfValidated
          ? `Validated — ${cellRef}. Click to remove your validation.`
          : state === "full-others" || state === "others"
            ? `Validated by others — ${cellRef}. Click to add your validation.`
            : `Not validated — ${cellRef}. Click to validate.`
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
        "active:scale-[0.88] disabled:cursor-not-allowed disabled:opacity-30 hover:bg-muted/80",
        validationColorClass,
        (state === "none" || state === "others" || state === "full-others") && "hover:text-green-500",
      )}
      disabled={!canValidateThisCell}
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
          <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
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
                  <li className="mb-1 px-1 text-xs text-muted-foreground">Validated by</li>
                  {displayedValidators.length === 0 ? (
                    <li className="px-1 py-1 text-xs text-muted-foreground">No active validators</li>
                  ) : displayedValidators.map((validator) => (
                    <li key={validator} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                      <span className="truncate">{validator}{validator === currentUsername ? " (you)" : ""}</span>
                      {validator === currentUsername && canValidate && (
                        <AppTooltip content="Remove your validation">
                          <button
                            type="button"
                            aria-label="Remove your validation"
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
              </PopoverContent>
            )}
          </Popover>
        ) : (
          <AppTooltip content={tooltip}>
            {renderButton(canValidateThisCell && !isSelfValidated
              ? () => changeValidation(true)
              : undefined)}
          </AppTooltip>
        )
      ) : null}
    </div>
  )
}
