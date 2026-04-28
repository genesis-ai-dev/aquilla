import type { CellHealthBreakdown } from "@/lib/parsers/types"
import { BreakdownContent } from "./BreakdownContent"

interface Props {
  breakdown: CellHealthBreakdown
  scopeLabel: string                               // "cell health" | "file health" | "project health"
  onCellClick?: (cellId: string) => void           // for neighbor/example links
  majorInfractionCount: number                     // for rules band
  biggestDrags?: Array<{ cellId: string; score: number }>  // file/project scope only
}

export function BreakdownPopover(props: Props) {
  return <BreakdownContent {...props} variant="popover" />
}
