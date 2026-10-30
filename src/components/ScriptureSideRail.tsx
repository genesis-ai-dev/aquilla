import { BookMarked, Shapes, UsersRound, type LucideIcon } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { RightRailPanel } from "@/lib/editor/right-rail-panels"
import { cn } from "@/lib/utils"

const TAB: Record<
  RightRailPanel,
  { icon: LucideIcon; label: MessageKey; testId: string }
> = {
  bibles: {
    icon: BookMarked,
    label: "editor.bibles.edgeTab",
    testId: "bibles-edge-tab",
  },
  resources: {
    icon: Shapes,
    label: "editor.resources.edgeTab",
    testId: "resources-edge-tab",
  },
  people: {
    icon: UsersRound,
    label: "bibleData.whosWho.panel.edgeTab",
    testId: "whos-who-edge-tab",
  },
}

interface ScriptureSideRailProps {
  tabs: RightRailPanel[]
  openPanel: RightRailPanel | null
  /** Clicking the open panel's button closes it; any other button opens that panel. */
  onSelect: (panel: RightRailPanel | null) => void
}

/** One slim rail of buttons that switches between the scripture side panels. */
export function ScriptureSideRail({ tabs, openPanel, onSelect }: ScriptureSideRailProps) {
  const t = useT()
  return (
    <div className="hidden h-full w-9 shrink-0 flex-col items-center gap-1 border-s bg-background pt-2 sm:flex">
      {tabs.map((tab) => {
        const { icon: Icon, label, testId } = TAB[tab]
        const active = tab === openPanel
        // Each button's word names it: no hover (AQU-2260).
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onSelect(active ? null : tab)}
            aria-label={t(label)}
            aria-pressed={active}
            data-testid={testId}
            className={cn(
              "flex w-8 flex-col items-center gap-1.5 rounded-md py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-wide [writing-mode:vertical-rl]">
              {t(label)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
