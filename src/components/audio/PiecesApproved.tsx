// How many of a cut take's pieces are approved, read-only (decision 7, Sam
// 2026-10-22). Each piece takes its own vote on its own row, so the take on
// top of them, in the Recording tab and in the recorder's list, has no vote of
// its own and says this instead.
//
// Slice 3A (Sam, Oct 29): in a narrow row the count is the first thing to
// shorten — "0 of 2 pieces approved", then "0 of 2 approved", then "0/2" — so
// the take's name and its length stay whole beside it. With `fit`, the count
// measures the room the text beside it in its row can spare: the elements of
// the row's `[data-fit-text]` keep their whole width, except those marked
// `data-fit="give"` (the date), which give way first. The whole sentence stays
// the hover text and what a screen reader reads.

import { useLayoutEffect, useRef, useState } from "react"
import { CheckCheck } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { AudioValidationTake } from "@/components/cell/AudioValidationControl"
import { piecesApproved } from "@/components/cell/audio-validation-state"

export type PiecesCountForm = "long" | "short" | "tiny"

/** The longest form that fits `room` px; the fraction when none does. */
export function pickPiecesCountForm(room: number, widths: Record<PiecesCountForm, number>): PiecesCountForm {
  // Half a pixel of slack: measured widths are fractional.
  if (widths.long <= room + 0.5) return "long"
  if (widths.short <= room + 0.5) return "short"
  return "tiny"
}

/** An element's width with its fractions (offsetWidth rounds them away). */
function widthOf(el: HTMLElement): number {
  return el.getBoundingClientRect().width || el.offsetWidth
}

/** The px the row's text can spare: its width, less what it must keep whole —
 *  and never below its own minimum width, which it keeps whatever it holds. */
function spareBeside(text: HTMLElement): number {
  const style = getComputedStyle(text)
  const gap = parseFloat(style.columnGap) || 0
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  const floor = parseFloat(style.minWidth) || 0
  let kept = 0
  let items = 0
  for (const child of Array.from(text.children) as HTMLElement[]) {
    items += 1
    if (child.dataset.fit === "give") continue
    // scrollWidth: the whole width of a name that is already cut short. Both
    // rounded UP: a name short of its text by a fraction of a pixel already
    // shows "…".
    kept += Math.ceil(Math.max(child.scrollWidth, widthOf(child)))
  }
  const needs = Math.max(padding + kept + gap * Math.max(0, items - 1), floor)
  return widthOf(text) - needs
}

export function PiecesApproved({
  pieces,
  requirement,
  testId,
  fit = false,
}: {
  /** The take's pieces as the validation control would draw them. */
  pieces: readonly AudioValidationTake[]
  /** The project's required number of approvals for audio. */
  requirement: number
  testId?: string
  /** Shorten to fit beside the row's text (the recorder's narrow list). */
  fit?: boolean
}) {
  const t = useT()
  const counted = piecesApproved(pieces, requirement)
  const [form, setForm] = useState<PiecesCountForm>("long")
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const shownRef = useRef<HTMLSpanElement | null>(null)
  const formsRef = useRef<HTMLSpanElement | null>(null)

  // Measured after every render (a rename, a new length, the date arriving)
  // and whenever the row changes size. The room it works out does not depend
  // on the form shown, so the choice never flips back and forth.
  useLayoutEffect(() => {
    if (!fit) return
    const measure = () => {
      const text = rootRef.current?.closest("[data-fit-row]")?.querySelector<HTMLElement>("[data-fit-text]")
      const shown = shownRef.current
      const forms = formsRef.current
      if (!text || !shown || !forms) return
      const formWidth = (f: PiecesCountForm) => {
        const el = forms.querySelector<HTMLElement>(`[data-count-form="${f}"]`)
        return el ? Math.ceil(widthOf(el)) : 0
      }
      const room = widthOf(shown) + spareBeside(text)
      setForm(pickPiecesCountForm(room, { long: formWidth("long"), short: formWidth("short"), tiny: formWidth("tiny") }))
    }
    measure()
    const row = rootRef.current?.closest("[data-fit-row]")
    if (!row || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  })

  if (!counted) return null
  const all = counted.approved === counted.total
  const sentence = t("editor.recordingTab.piecesApproved", { approved: counted.approved, count: counted.total })
  const text: Record<PiecesCountForm, string> = {
    long: sentence,
    short: t("editor.recordingTab.piecesApprovedShort", { approved: counted.approved, count: counted.total }),
    tiny: t("editor.recordingTab.piecesApprovedTiny", { approved: counted.approved, count: counted.total }),
  }
  const shownForm = fit ? form : "long"
  return (
    <span
      ref={rootRef}
      data-testid={testId}
      data-all-approved={all ? "true" : "false"}
      data-form={shownForm}
      data-fit={fit ? "beside-text" : undefined}
      // The whole sentence on hover, whichever form is shown.
      title={sentence}
      className={cn(
        "flex min-w-0 items-center gap-1 text-[11px]",
        fit && "relative",
        all ? "text-green-600 dark:text-green-500" : "text-muted-foreground",
      )}
    >
      {all && <CheckCheck className="h-3 w-3 shrink-0" />}
      {shownForm !== "long" && <span className="sr-only">{sentence}</span>}
      <span
        ref={shownRef}
        data-count-text={shownForm}
        aria-hidden={shownForm !== "long" ? true : undefined}
        className="truncate"
      >
        {text[shownForm]}
      </span>
      {fit && (
        // Every form, measured where nothing can see or reach it, in a box of
        // no size so it never widens the row or the list.
        <span aria-hidden className="pointer-events-none invisible absolute start-0 top-0 h-0 w-0 overflow-hidden">
          <span ref={formsRef} className="flex w-max whitespace-nowrap">
            <span data-count-form="long">{text.long}</span>
            <span data-count-form="short">{text.short}</span>
            <span data-count-form="tiny">{text.tiny}</span>
          </span>
        </span>
      )}
    </span>
  )
}
