/**
 * NavHistoryControls — browser-style back/forward buttons for the top-left of
 * the app chrome, plus a history menu.
 *
 * - Clock: open a dropdown of visited pages; click an entry to jump to it.
 * - Click an arrow: go back / forward one step.
 *
 * Renders nothing when there's no NavHistoryProvider (e.g. in page-level tests).
 */
import { useState } from "react"
import { Check, ChevronLeft, ChevronRight, Clock } from "lucide-react"
import { useNavHistory, type NavHistoryValue } from "@/context/NavHistoryContext"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"

export function NavHistoryControls() {
  const nav = useNavHistory()
  if (!nav) return null
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Page history">
      <HistoryMenuButton nav={nav} />
      <NavArrowButton direction="back" nav={nav} />
      <NavArrowButton direction="forward" nav={nav} />
    </div>
  )
}

function HistoryMenuButton({ nav }: { nav: NavHistoryValue }) {
  const [open, setOpen] = useState(false)
  const hasHistory = nav.entries.length > 1
  // Newest stack end first so the current page sits near the top when at the tip.
  const list = nav.entries
    .map((entry, target) => ({ entry, target }))
    .reverse()

  if (!hasHistory) {
    return (
      <AppTooltip content="No history" side="bottom" disabled={open}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled
          aria-label="History"
          className="cursor-default text-muted-foreground/30"
        >
          <Clock />
        </Button>
      </AppTooltip>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <AppTooltip content="History" side="bottom" disabled={open}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="History"
            >
              <Clock />
            </Button>
          }
        />
      </AppTooltip>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>History</DropdownMenuLabel>
          {list.map(({ entry, target }) => {
            const isCurrent = target === nav.index
            return (
              <DropdownMenuItem
                key={`${entry.key}-${target}`}
                disabled={isCurrent}
                onClick={() => {
                  if (!isCurrent) nav.go(target)
                }}
              >
                {isCurrent ? <Check /> : <Clock />}
                <span className="truncate">{entry.title}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NavArrowButton({ direction, nav }: { direction: "back" | "forward"; nav: NavHistoryValue }) {
  const isBack = direction === "back"
  const enabled = isBack ? nav.canGoBack : nav.canGoForward
  const label = isBack ? "Back" : "Forward"
  const Icon = isBack ? ChevronLeft : ChevronRight
  const nearest = isBack
    ? nav.entries[nav.index - 1]?.title
    : nav.entries[nav.index + 1]?.title

  return (
    <AppTooltip
      content={enabled ? label : `No ${label.toLowerCase()} history`}
      side="bottom"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={!enabled}
        aria-label={enabled && nearest ? `${label} to ${nearest}` : label}
        onClick={() => {
          if (isBack) nav.goBack()
          else nav.goForward()
        }}
        className={enabled ? undefined : "cursor-default text-muted-foreground/30"}
      >
        <Icon />
      </Button>
    </AppTooltip>
  )
}
