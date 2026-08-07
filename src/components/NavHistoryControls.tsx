/**
 * NavHistoryControls — browser-style back/forward plus a previously-viewed
 * menu of concrete projects, teams, and editor files (max 15).
 *
 * - Clock: open recently viewed entities; click to jump.
 * - Click an arrow: go back / forward one browser-history step.
 *
 * Renders nothing when there's no NavHistoryProvider (e.g. in page-level tests).
 */
import { useState } from "react"
import { ChevronLeft, ChevronRight, Clock } from "lucide-react"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { useNavHistory, type NavHistoryValue } from "@/context/NavHistoryContext"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import {
  MAX_RECENT_VISITS,
  RECENT_KIND_LABEL,
  type RecentEntity,
} from "@/lib/navigation/recent-visits"
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
  const list = nav.recent.slice(0, MAX_RECENT_VISITS)
  const hasRecent = list.length > 0

  if (!hasRecent) {
    return (
      <AppTooltip content="No previously viewed pages" side="bottom" disabled={open}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled
          aria-label="Previously viewed"
          className="cursor-default text-muted-foreground/30"
        >
          <Clock />
        </Button>
      </AppTooltip>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <AppTooltip content="Previously viewed" side="bottom" disabled={open}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Previously viewed"
            >
              <Clock />
            </Button>
          }
        />
      </AppTooltip>
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="min-w-56 w-max max-w-96 text-sm">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 py-1 text-sm font-normal">
            Previously viewed
          </DropdownMenuLabel>
          {list.map((entry) => (
            <RecentItem
              key={`${entry.kind}-${entry.id}`}
              entry={entry}
              onPick={() => {
                setOpen(false)
                nav.openRecent(entry.pathname, entry.search)
              }}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RecentItem({ entry, onPick }: { entry: RecentEntity; onPick: () => void }) {
  const kindLabel = RECENT_KIND_LABEL[entry.kind]
  const ProjectIcon = NAV_PAGE_ICONS.project
  const FileIcon = NAV_PAGE_ICONS.file
  // Color is hashed from the full team title (same as TeamWithAvatar).
  // `singleInitial` only shrinks the glyph — it does not affect colorFromName.
  const teamName = entry.title.trim()
  // Kind and title share the same type size/weight; only color differs.
  const itemText = "text-sm font-normal leading-5"
  return (
    <DropdownMenuItem onClick={onPick} className="gap-2 px-2 py-1.5 text-sm">
      <span className={`w-14 shrink-0 ${itemText} text-muted-foreground`}>{kindLabel}</span>
      {entry.kind === "team" ? (
        <InitialsAvatar
          name={teamName}
          size="xs"
          className="size-4!"
          menuSafe
          singleInitial
        />
      ) : entry.kind === "file" ? (
        <FileIcon className="size-4" />
      ) : (
        <ProjectIcon className="size-4" />
      )}
      <span className={`min-w-0 flex-1 truncate ${itemText}`}>{entry.title}</span>
    </DropdownMenuItem>
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
