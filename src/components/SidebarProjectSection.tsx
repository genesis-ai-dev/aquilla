import { useState } from "react"
import { MoreHorizontal, type LucideIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ProjectNavItem {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  /** Pinned items render as always-visible rows; the rest live in "More". */
  pinned?: boolean
  onClick: () => void
}

interface Props {
  items: ProjectNavItem[]
}

function NavRow({ item, onAfterClick }: { item: ProjectNavItem; onAfterClick?: () => void }) {
  return (
    <button
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
      )}
      onClick={() => {
        item.onClick()
        onAfterClick?.()
      }}
    >
      <item.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className="rounded-md px-1.5 text-[10px] tabular-nums text-primary">
          {item.badge}
        </span>
      )}
    </button>
  )
}

export function SidebarProjectSection({ items }: Props) {
  const [moreOpen, setMoreOpen] = useState(false)
  const pinned = items.filter((i) => i.pinned)
  const overflow = items.filter((i) => !i.pinned)
  // Surface overflow badge activity (e.g. unread counts) on the More row so
  // tucking an item away never hides live information.
  const overflowBadge = overflow.reduce((sum, i) => sum + (i.badge ?? 0), 0)

  return (
    <div className="px-2 py-1">
      {/*
        Use flex gap (not space-y): Base UI inserts focus-guard <span>s as
        siblings of the popover trigger while open. space-y's :not(:last-child)
        margins then land on More and grow this section by 2px, which steals
        height from the flex-1 file list above and makes the row jump upward.
        Gap only spaces in-flow items, and the wrapper below keeps any guards
        out of this list's child set entirely.
      */}
      <div className="flex flex-col gap-0.5">
        {pinned.map((item) => (
          <NavRow key={item.id} item={item} />
        ))}
        {overflow.length > 0 && (
          <div>
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger
                render={
                  <button
                    // Distinct accessible name: the workspace header already has a
                    // button named exactly "More" (OverflowMenu).
                    aria-label="More project options"
                    className={cn(
                      "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors",
                      "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
                      moreOpen ? "bg-accent text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate text-left">More</span>
                    {overflowBadge > 0 && (
                      <span className="rounded-md px-1.5 text-[10px] tabular-nums text-primary">
                        {overflowBadge}
                      </span>
                    )}
                  </button>
                }
              />
              <PopoverContent side="top" align="start" className="min-w-[180px] rounded-xl p-1">
                <div className="flex flex-col">
                  {overflow.map((item) => (
                    <NavRow key={item.id} item={item} onAfterClick={() => setMoreOpen(false)} />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
    </div>
  )
}
