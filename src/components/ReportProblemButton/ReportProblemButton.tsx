/**
 * FRO-307: Always-available "Report a problem" trigger.
 *
 * Mounted once in the AppShell left-rail footer (alongside VersionTag).
 * Small, unobtrusive — icon + tooltip on hover.
 */

import { useState } from "react"
import { Flag } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ReportProblemDialog } from "./ReportProblemDialog"

export function ReportProblemButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              onClick={() => setOpen(true)}
              aria-label="Report a problem"
              className="mr-2 flex w-fit shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/50 hover:bg-accent/60 hover:text-muted-foreground transition-colors"
            >
              <Flag className="h-3 w-3 shrink-0" aria-hidden />
              <span className="sr-only">Report a problem</span>
            </button>
          }
        />
        <TooltipContent side="right">Report a problem</TooltipContent>
      </Tooltip>

      <ReportProblemDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
