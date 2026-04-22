import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { CellHealthBreakdown } from "@/lib/parsers/types"
import { BreakdownTooltip } from "./BreakdownTooltip"
import { BreakdownPopover } from "./BreakdownPopover"

interface Props {
  breakdown: CellHealthBreakdown
  scopeLabel: string
  onCellClick?: (cellId: string) => void
  majorInfractionCount: number
  biggestDrags?: Array<{ cellId: string; score: number }>
  children: React.ReactNode
}

export function HealthBreakdown({
  breakdown, scopeLabel, onCellClick, majorInfractionCount, biggestDrags, children,
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <TooltipProvider delay={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative inline-flex items-center">
          <Tooltip>
            <TooltipTrigger render={<span />}>
              {children}
            </TooltipTrigger>
            <TooltipContent side="top">
              <BreakdownTooltip breakdown={breakdown} />
            </TooltipContent>
          </Tooltip>
          <PopoverTrigger
            aria-label="breakdown detail"
            className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </PopoverTrigger>
        </div>
        <PopoverContent side="bottom" align="start" className="p-0">
          <BreakdownPopover
            breakdown={breakdown}
            scopeLabel={scopeLabel}
            onCellClick={(id) => { setOpen(false); onCellClick?.(id) }}
            majorInfractionCount={majorInfractionCount}
            biggestDrags={biggestDrags}
          />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
