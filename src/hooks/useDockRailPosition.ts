import { useEffect, useState } from "react"
import {
  getDockRailPosition,
  setDockRailPosition,
  onDockRailPositionChange,
  type DockRailPosition,
} from "@/lib/dock-rail-position"

export function useDockRailPosition(): {
  position: DockRailPosition
  setPosition: (next: DockRailPosition) => void
} {
  const [position, setPositionState] = useState<DockRailPosition>(() => getDockRailPosition())

  useEffect(() => onDockRailPositionChange(setPositionState), [])

  return {
    position,
    setPosition: setDockRailPosition,
  }
}
