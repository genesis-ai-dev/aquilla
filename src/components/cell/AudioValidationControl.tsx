import { Fragment, useEffect, useMemo, useState, type SyntheticEvent } from "react"
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

  // Retire a guess the moment the server's answer for that take has MOVED
  // from what it was when we asked. Leaving it in the map — which is what
  // this did — meant a later state that happened to match `atRequest` again
  // re-armed it: validate here, then withdraw from the Recording tab, and
  // the gutter painted the vote back on and kept it until the row recycled.
  // (Adversarial review, 2026-09-22.)
  useEffect(() => {
    const stale = takes.filter((take) => {
      const guess = pending[take.audioId]
      return guess && guess.atRequest !== take.validators.includes(currentUsername)
    })
    if (stale.length === 0) return
    setPending((current) => {
      const next = { ...current }
      for (const take of stale) delete next[take.audioId]
      return next
    })
  }, [takes, pending, currentUsername])

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

  const hasVoterInfo = displayed.some((take) => take.validators.length > 0)
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
  const clickable = mineToGive.length > 0
  // Why the viewer cannot add a vote, for the foot of the list. Nothing when
  // they can, or when every take already carries theirs.
  const blockedNote = !clickable && !allMine ? tooltip : null

  // THE LABEL IS DERIVED FROM `state`, the same thing the icon is. It used to
  // come from `allMine`, a different question — so a line two other people
  // had fully validated drew a green double check and announced "Audio not
  // validated, click to validate", and a line where I had just signed off the
  // last take I was allowed to touch said the same. Four such disagreements
  // were reachable (adversarial review, 2026-09-22); deriving both from one
  // value is what stops a fifth.
  const ariaLabel = state === "full"
    // "Click to remove your validation" only when there IS one of mine on
    // every take. A line others finished used to say it to someone who had
    // never voted (Sam, 2026-09-23) — the text control's "by others" twin.
    ? (allMine
        ? t("editor.audioValidation.ariaValidated", { ref: cellRef })
        : clickable
          ? t("editor.audioValidation.ariaValidatedByOthers", { ref: cellRef })
          : t("editor.audioValidation.ariaValidatedNoAction", { ref: cellRef }))
    : state === "self"
      ? (shortBy > 0
          ? t("editor.audioValidation.ariaYoursMoreNeeded", { ref: cellRef, count: shortBy })
          : t("editor.audioValidation.ariaValidated", { ref: cellRef }))
      : showFraction
        ? t("editor.audioValidation.ariaPartlyValidated", {
            done: mineDone, total: displayed.length, ref: cellRef,
          })
        : state === "others"
          ? t("editor.audioValidation.ariaOthersValidated", { ref: cellRef, count: Math.max(1, shortBy) })
          // "Click to validate" only when a click would DO something. A line
          // whose remaining takes are all blocked for me — my own recording
          // on a project that forbids self-validation, say — used to point a
          // screen reader at a dead button.
          : clickable
            ? t("editor.audioValidation.ariaNotValidated", { ref: cellRef })
            : t("editor.audioValidation.ariaNotValidatedByYou", { ref: cellRef })

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

  // A line with nothing recorded draws a FADED mic in the gutter (Sam,
  // 2026-09-23, reversing the empty slot of 09-21): both gutter columns read
  // full on every row, and "nothing to validate" looks different from "not
  // validated yet". A span, not a disabled button — no tab stop, and it still
  // takes the hover that says why. Inline surfaces (the take block, the chips)
  // only ever mount beside a take, so there it is still nothing.
  if (state === "empty") {
    if (variant === "inline") return null
    return (
      <div data-testid="audio-validation-gutter" className="flex w-6 shrink-0 items-start pt-1">
        <AppTooltip key="unavailable" content={t("editor.audioValidation.noAudioTooltip")}>
          <span
            role="img"
            data-testid="audio-validation-unavailable"
            aria-label={t("editor.audioValidation.ariaNoAudio", { ref: cellRef })}
            className="flex h-6 w-6 cursor-default items-center justify-center text-muted-foreground/30 opacity-40"
          >
            <Mic className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </AppTooltip>
      </div>
    )
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
        {/* Headed like the text control's list, so the two popovers read as
            one kind of thing. Several takes get the per-take heading instead,
            since each take below carries its own list. */}
        <div className="mb-1 px-1 text-xs text-muted-foreground">
          {displayed.length > 1
            ? t("editor.audioValidation.takesHeading")
            : t("editor.validation.validatedBy")}
        </div>
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
                        {/* Withdrawing is NOT gated on `canValidate`. That
                            flag is false for a take you recorded yourself on
                            a project that forbids self-validation — right for
                            casting a vote, wrong for taking one back. The
                            recorder auto-validates a fresh take, so flipping
                            that setting afterwards used to strand the vote
                            with no way to remove it here. The bulk predicate
                            already refuses this gate for the same reason. */}
                        {validator === currentUsername && (
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
                    {t("editor.audioValidation.validateThisTake")}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {blockedNote && (
          <div data-testid="audio-validation-blocked-note" className="mt-1 border-t border-border px-1 pt-1.5 text-[11px] text-muted-foreground">
            {blockedNote}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )

  // THE SAME HOVER RULE AS TEXT (Sam, 2026-09-23). Until somebody has voted
  // there is no list worth opening, so the hover is a TOOLTIP saying what a
  // click would do — or why it would not. From the first vote on, the hover is
  // the "Validated by" list, and the why-not rides at its foot. This used to
  // open the popover on every line, and a popover suppresses the tooltip
  // around it: an untouched line said "Nobody has validated this take" where
  // text said "click to validate", and "you recorded this" was unreachable.
  //
  // THE KEYS ARE LOAD-BEARING. Every line first draws before its audio has
  // loaded, so as the faded "no audio" mic; the take arrives a moment later.
  // Without distinct keys React reuses that tooltip for the real button, and
  // Base UI attaches its hover listeners ONCE, to the element it first saw —
  // the span that has just been thrown away. The real button then never opened
  // its tooltip on hover (found in the browser, 2026-09-23: the button had no
  // mouseenter listener at all). A key makes each shape mount its own.
  const wrapped = hasVoterInfo
    ? <Fragment key="list">{body}</Fragment>
    : (
        <AppTooltip key="tooltip" content={tooltip}>
          {renderButton(clickable ? validateAll : undefined)}
        </AppTooltip>
      )
  if (variant === "inline") return wrapped
  return (
    <div data-testid="audio-validation-gutter" className="flex shrink-0 items-start pt-1">
      {wrapped}
    </div>
  )
}
