import type { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * The "Managed term: X" tooltip over the key-term chips of one run of target
 * text, as ONE tooltip root the chips are detached triggers of (AQU-2655,
 * decision 0013: one instance per list, told which item it is for).
 *
 * An `AppTooltip` per chip mounted a tooltip root, a trigger and a closed
 * portal for every rendering on every row, on every render of the row. Here a
 * chip is only a trigger that carries its term; the shared root shows the term
 * of whichever chip opened it. Hover delay, focus and the popup are Base UI's,
 * exactly as they were.
 */
export type TermChipTooltipHandle = TooltipPrimitive.Handle<string>

export function TermChipTrigger({
  handle,
  term,
  children,
}: {
  handle: TermChipTooltipHandle
  term: string
  children: ReactElement
}) {
  return <TooltipTrigger handle={handle} payload={term} render={children} />
}

export function TermChipTooltip({ handle }: { handle: TermChipTooltipHandle }) {
  const t = useT()
  return (
    <Tooltip handle={handle}>
      {({ payload }) => (
        <TooltipContent side="bottom">
          {typeof payload === "string" ? t("editor.term.managed", { term: payload }) : null}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
