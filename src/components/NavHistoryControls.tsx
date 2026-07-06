/**
 * NavHistoryControls — browser-style back/forward buttons for the top-left of
 * the app chrome.
 *
 * - Click an arrow: go back / forward one step.
 * - Press and hold an arrow (or right-click it): open a popover listing the
 *   human-readable history in that direction; click an entry to jump to it.
 *
 * Renders nothing when there's no NavHistoryProvider (e.g. in page-level tests).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react"
import { ChevronLeft, ChevronRight, Clock } from "lucide-react"
import { useNavHistory, type NavEntry, type NavHistoryValue } from "@/context/NavHistoryContext"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const HOLD_MS = 350

export function NavHistoryControls() {
  const nav = useNavHistory()
  if (!nav) return null
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Page history">
      <NavArrowButton direction="back" nav={nav} />
      <NavArrowButton direction="forward" nav={nav} />
    </div>
  )
}

interface HistoryTarget {
  entry: NavEntry
  target: number
}

function NavArrowButton({ direction, nav }: { direction: "back" | "forward"; nav: NavHistoryValue }) {
  const isBack = direction === "back"
  const enabled = isBack ? nav.canGoBack : nav.canGoForward
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const holdTimer = useRef<number | null>(null)
  const heldRef = useRef(false)

  // Entries in this direction, nearest-first.
  const list: HistoryTarget[] = []
  if (isBack) {
    for (let i = nav.index - 1; i >= 0; i--) list.push({ entry: nav.entries[i], target: i })
  } else {
    for (let i = nav.index + 1; i < nav.entries.length; i++) list.push({ entry: nav.entries[i], target: i })
  }

  function clearHold() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!enabled || e.button !== 0) return
    heldRef.current = false
    clearHold()
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true
      setOpen(true)
    }, HOLD_MS)
  }

  function onClick() {
    clearHold()
    // A hold opened the popover — swallow the click so we don't also navigate.
    if (heldRef.current) {
      heldRef.current = false
      return
    }
    if (isBack) nav.goBack()
    else nav.goForward()
  }

  function onContextMenu(e: ReactMouseEvent<HTMLButtonElement>) {
    if (!enabled) return
    e.preventDefault()
    setOpen(true)
  }

  const label = isBack ? "Back" : "Forward"
  const Icon = isBack ? ChevronLeft : ChevronRight
  const nearest = list[0]?.entry.title

  const button = (
    <Button
      ref={btnRef}
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={!enabled}
      aria-label={enabled && nearest ? `${label} to ${nearest}` : label}
      onPointerDown={onPointerDown}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={enabled ? undefined : "cursor-default text-muted-foreground/30"}
    >
      <Icon className="size-4" aria-hidden />
    </Button>
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipContent side="bottom">
          {enabled ? `${label} · hold for history` : `No ${label.toLowerCase()} history`}
        </TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent
          anchor={btnRef}
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-64 p-1"
        >
          <HistoryList
            list={list}
            direction={direction}
            onPick={(target) => {
              setOpen(false)
              nav.go(target)
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  )
}

function HistoryList({
  list,
  direction,
  onPick,
}: {
  list: HistoryTarget[]
  direction: "back" | "forward"
  onPick: (target: number) => void
}) {
  if (list.length === 0) {
    return <div className="px-2 py-3 text-center text-xs text-muted-foreground">No history</div>
  }
  return (
    <div className="max-h-80 overflow-y-auto">
      <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {direction === "back" ? "Back" : "Forward"}
      </div>
      <ul className="flex flex-col">
        {list.map(({ entry, target }) => (
          <li key={`${entry.key}-${target}`}>
            <button
              type="button"
              onClick={() => onPick(target)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/60"
            >
              <Clock className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
              <span className="truncate">{entry.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
