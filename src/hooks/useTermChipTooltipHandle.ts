import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { useState } from "react"
import type { TermChipTooltipHandle } from "@/components/cell/TermChipTooltip"

/** The handle that ties one run of target text's chips to its shared tooltip (AQU-2655). */
export function useTermChipTooltipHandle(): TermChipTooltipHandle {
  const [handle] = useState(() => TooltipPrimitive.createHandle<string>())
  return handle
}
