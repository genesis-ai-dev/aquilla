// An (i) that holds a setting's or a control's longer explanation, so the
// screen keeps only the short label (Sam, Oct 25: long sub-text goes behind an
// info icon). The same button the Timing control's (i) draws.

import { Info } from "lucide-react"
import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function InfoTip({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            className="inline-flex shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  )
}
