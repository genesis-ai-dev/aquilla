import { useMemo, useState, type SyntheticEvent } from "react"
import { Check, CheckCheck, Mic, Trash2 } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { lineState } from "./audio-validation-state"

/**
 * AQU-490: one line's audio validation, as the five surfaces all draw it.
 *
 * THE DIFFERENCE FROM THE TEXT CONTROL, and the reason this is a sibling
 * rather than a prop on it: a vote is on a TAKE, and a line can hold several —
 * one per track, all of which sound at once. Sam's rule is that every track
 * holding a chosen take must be validated before the line counts, so this
 * control represents a SET and the icon shows the set's weakest member.
 *
 * The takes handed in are already the selected dub ones (`selectedDubTakes`);
 * this component never sees the imported programme audio, and never filters
 * for it either — one definition of that, in cell-audio-read-types.ts.
 */

export interface AudioValidationTake {
  audioId: string
  /** The take's display name, or null to fall back to the track label. */
  label: string | null
  /** Which track it sits on. "recording" is the default track. */
  slot: string
  validatorCount: number
  validators: string[]
  /** TTS rather than a person. Never auto-validated; can still be validated by hand. */
  isGenerated: boolean
  /**
   * May the viewer validate THIS take? Computed by the caller, because it
   * folds the project's role floor, its named-validator list and — per take —
   * whether the viewer is the one who recorded it.
   */
  canValidate: boolean
  /** Why not, when `canValidate` is false. Shown as the tooltip. */
  blockedReason?: string
}

interface AudioValidationControlProps {
  cellRef: string
  takes: AudioValidationTake[]
  currentUsername: string
  /** The project's required number of validators for audio. */
  validationRequirement: number
  /** May the viewer validate audio anywhere in this project? */
  canValidate: boolean
  onValidationChange: (audioId: string, validated: boolean) => unknown
  /**
   * "gutter" wears the fixed-width column wrapper the text control uses, so
   * the two line up. "inline" is bare, for the take block and the chips.
   */
  variant?: "gutter" | "inline"
}

type PreventableReactEvent<T> = SyntheticEvent<T> & {
  preventBaseUIHandler?: () => void
}

export function AudioValidationControl({
  cellRef,
  takes,
  currentUsername,
  validationRequirement,
  canValidate,
  onValidationChange,
  variant = "gutter",
}: AudioValidationControlProps) {
  const { t } = useI18n()
  const [popoverOpen, setPopoverOpen] = useState(false)
  /**
   * audioId → the vote we asked for, plus what the server said at the moment
   * we asked.
   *
   * Carrying `atRequest` is what lets the optimistic value expire during
   * RENDER rather than in an effect: once the server's answer for a take stops
   * matching what it was when we asked, our guess is stale by definition and
   * is simply ignored. Per take, because a line with three tracks sends three
   * events and they land as three separate reads — expiring them together
   * would snap the two that had arrived back to their old state while the
   * third was still in flight.
   */
  const [pending, setPending] = useState<Record<string, { value: boolean; atRequest: boolean }>>({})

  const displayed = useMemo(() => takes.map((take) => {
    const guess = pending[take.audioId]
    const has = take.validators.includes(currentUsername)
    if (!guess || guess.atRequest !== has || guess.value === has) return take
    return {
      ...take,
      validators: guess.value
        ? [...take.validators, currentUsername]
        : take.validators.filter((name) => name !== currentUsername),
      validatorCount: Math.max(0, take.validatorCount + (guess.value ? 1 : -1)),
    }
  }), [takes, pending, currentUsername])

  const requirement = Math.max(1, validationRequirement)
  const state = lineState(displayed, currentUsername, requirement)
  const mineToGive = displayed.filter(
    (take) => take.canValidate && !take.validators.includes(currentUsername),
  )
  // THE FRACTION IS YOUR PROGRESS ACROSS THE TRACKS, not the line's. Sam,
  // 2026-09-22, after seeing "0/2" beside a single check on a line he had
  // fully signed off: it used to count takes that had REACHED the threshold,
  // so at a threshold of two it sat at zero however much you had done and
  // read as if nothing had happened. It now counts the takes carrying YOUR
  // vote, out of the takes on the line, and shows only while a track still
  // needs you — once you have done every track it goes, and the icon alone
  // says the rest (single check: waiting on others; double: finished). That
  // is also exactly what a click does: give your vote to the tracks without
  // it. The hover list still tells the fuller story per take.
  const mineDone = displayed.filter((take) => take.validators.includes(currentUsername)).length
  const showFraction = displayed.length > 1 && state !== "full" && mineToGive.length > 0
  const allMine = displayed.length > 0 && mineToGive.length === 0
    && displayed.every((take) => take.validators.includes(currentUsername))

  const change = (audioId: string, validated: boolean) => {
    const atRequest = takes
      .find((take) => take.audioId === audioId)
      ?.validators.includes(currentUsername) ?? false
    setPending((current) => ({ ...current, [audioId]: { value: validated, atRequest } }))
    void Promise.resolve(onValidationChange(audioId, validated))
      .then((accepted) => {
        if (accepted === false) {
          setPending((current) => {
            const next = { ...current }
            delete next[audioId]
            return next
          })
        }
      })
      .catch(() => {
        setPending((current) => {
          const next = { ...current }
          delete next[audioId]
          return next
        })
      })
  }

  /** One gesture for the whole line: give every take still missing my vote. */
  const validateAll = () => {
    for (const take of mineToGive) change(take.audioId, true)
  }

  const Icon = state === "full" ? CheckCheck : state === "self" ? Check : Mic
  const colorClass = state === "full" || state === "self"
    ? "text-green-500"
    : state === "others" ? "text-muted-foreground/60" : "text-muted-foreground/30"
  /**
   * SOMEBODY ELSE HAS VALIDATED THIS, and the threshold is not met yet.
   *
   * The text control says this by FILLING its circle (`fill="currentColor"`
   * on the icon), and until Sam pointed it out this one said it only by
   * stepping the grey from /30 to /60 — a difference you cannot see on a
   * 14px glyph. On a second account, "nobody has listened to this" and
   * "somebody has" looked identical, which is precisely the state a second
   * validator needs to find.
   *
   * Only the CAPSULE fills, not the whole mic. Lucide's mic is three
   * sub-elements and the U-shaped stand is an open path: SVG closes a path
   * implicitly to fill it, so a blanket `fill` turns the lower two-thirds of
   * the icon into a solid blob. The capsule is the one closed shape in it,
   * and filling that alone reads exactly as the text control's filled circle
   * does at the same size.
   */
  const fillCapsule = state === "others"

  const blocked = displayed.find((take) => !take.canValidate && take.blockedReason)
  const tooltip = mineToGive.length > 0
    ? t("editor.audioValidation.notValidatedTooltip")
    : blocked?.blockedReason
      ?? (canValidate
        ? t("editor.audioValidation.outOfScopeTooltip")
        : t("editor.audioValidation.unavailableTooltip"))

  // The shortest distance any take still is from the threshold, so the label
  // can say "one more needed" rather than a bare "validated" while the icon
  // beside it is still a single check. Found in the browser: at a threshold of
  // two the button announced "Recording validated" on a line that visibly was
  // not, which is the picture and the words disagreeing.
  const shortBy = displayed.reduce(
    (worst, take) => Math.max(worst, Math.max(0, requirement - take.validatorCount)),
    0,
  )
  const ariaLabel = allMine && shortBy > 0
    ? t("editor.audioValidation.ariaYoursMoreNeeded", { ref: cellRef, count: shortBy })
    : allMine
    ? t("editor.audioValidation.ariaValidated", { ref: cellRef })
    : showFraction
      ? t("editor.audioValidation.ariaPartlyValidated", {
          done: mineDone, total: displayed.length, ref: cellRef,
        })
      : t("editor.audioValidation.ariaNotValidated", { ref: cellRef })

  const clickable = mineToGive.length > 0
  const trackLabel = (take: AudioValidationTake) =>
    take.label
    ?? (take.isGenerated
      ? t("editor.audioValidation.generatedTake")
      : take.slot === "recording"
        ? t("editor.audioValidation.defaultTrack")
        : take.slot)

  const renderButton = (onClick?: () => void) => (
    <button
      type="button"
      data-showcase="cell.audioValidation"
      data-testid="audio-validation-button"
      aria-pressed={allMine}
      aria-label={ariaLabel}
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
        "relative flex h-6 items-center justify-center gap-0.5 rounded-lg",
        "transition-[transform,color,background-color] duration-150 ease-out",
        "active:scale-[0.88] disabled:cursor-not-allowed disabled:opacity-30 hover:bg-muted/80",
        showFraction ? "w-auto px-1" : "w-6",
        colorClass,
        clickable && "hover:text-green-500",
      )}
      // NEVER `disabled`, deliberately. A disabled button fires no pointer
      // events, so disabling it would swallow the hover that explains WHY the
      // viewer cannot vote — the tooltip saying "you recorded this" would be
      // unreachable on exactly the lines that need it. A press does nothing
      // when there is nothing to give, because no handler is wired; the muted
      // colour is what says so. (Same trap as the AQU-1068 tooltip.)
    >
      <Icon
        className={cn("relative h-3.5 w-3.5", fillCapsule && "[&_rect]:fill-current")}
        strokeWidth={2.5}
      />
      {showFraction && (
        <span className="text-[10px] font-medium tabular-nums leading-none" data-testid="audio-validation-fraction">
          {t("editor.audioValidation.takeFraction", { done: mineDone, total: displayed.length })}
        </span>
      )}
    </button>
  )

  // A line with nothing recorded draws NOTHING — the same rule as text, where
  // a cell with no text has no validation control either. (Sam, 2026-09-21,
  // after a placeholder mic was tried and rejected: there is nothing to
  // validate, so there is nothing to show.) The gutter slot survives so the
  // column keeps its width.
  if (state === "empty") {
    return variant === "inline"
      ? null
      : <div data-testid="audio-validation-gutter" className="flex shrink-0 items-start pt-1" />
  }

  const body = (
    <Popover open={popoverOpen} onOpenChange={(next: boolean, details: { reason: string; cancel(): void }) => {
      if (!next) { setPopoverOpen(false); return }
      // A press on a line the viewer can still act on is the VOTE, not the
      // popover — the same bargain the text control strikes. Once there is
      // nothing left to give, the press opens the list instead.
      if ((details.reason === "trigger-press" || details.reason === "keyboard") && clickable) {
        details.cancel()
        return
      }
      setPopoverOpen(true)
    }}>
      <PopoverTrigger
        openOnHover
        delay={400}
        closeDelay={100}
        render={renderButton(clickable ? validateAll : undefined)}
      />
      <PopoverContent side="right" align="start" className="w-72 rounded-xl p-2">
        {displayed.length > 1 && (
          <div className="mb-1 px-1 text-xs text-muted-foreground">
            {t("editor.audioValidation.takesHeading")}
          </div>
        )}
        <ul className="space-y-1">
          {displayed.map((take) => {
            const mine = take.validators.includes(currentUsername)
            const short = Math.max(0, requirement - take.validatorCount)
            return (
              <li key={take.audioId} className="rounded px-1 py-1 text-xs">
                {displayed.length > 1 && (
                  <div className="mb-0.5 flex items-center gap-1 font-medium">
                    <span className="truncate">{trackLabel(take)}</span>
                    {short > 0 && (
                      <span className="ms-auto shrink-0 text-[10px] font-normal text-muted-foreground">
                        {t("editor.audioValidation.needsMore", { count: short })}
                      </span>
                    )}
                  </div>
                )}
                {take.validators.length === 0 ? (
                  <div className="text-muted-foreground">{t("editor.audioValidation.noValidators")}</div>
                ) : (
                  <ul className="space-y-0.5">
                    {take.validators.map((validator) => (
                      <li key={validator} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-muted/50">
                        <span className="truncate">
                          {validator}
                          {validator === currentUsername ? ` ${t("editor.validation.you")}` : ""}
                        </span>
                        {validator === currentUsername && take.canValidate && (
                          <AppTooltip content={t("editor.validation.removeYours")}>
                            <button
                              type="button"
                              aria-label={t("editor.validation.removeYours")}
                              className="shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => {
                                change(take.audioId, false)
                                if (displayed.length === 1) setPopoverOpen(false)
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </AppTooltip>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!mine && take.canValidate && displayed.length > 1 && (
                  <button
                    type="button"
                    className="mt-0.5 rounded px-1 py-0.5 text-[11px] text-green-600 hover:bg-muted/60"
                    onClick={() => change(take.audioId, true)}
                  >
                    {t("editor.audioValidation.notValidatedTooltip")}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )

  const wrapped = <AppTooltip content={tooltip}>{body}</AppTooltip>
  if (variant === "inline") return wrapped
  return (
    <div data-testid="audio-validation-gutter" className="flex shrink-0 items-start pt-1">
      {wrapped}
    </div>
  )
}
