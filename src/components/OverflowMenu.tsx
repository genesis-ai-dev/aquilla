import type { ComponentType } from "react"
import { Menu } from "@base-ui/react/menu"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/branding/ThemeMode"
import { ColorThemePicker } from "@/branding/ColorTheme"

export interface OverflowMenuItem {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  onClick: () => void
}

interface Props {
  items: OverflowMenuItem[]
  /** When true (default), appends a Theme row at the bottom. */
  includeTheme?: boolean
}

const ITEM_CLASS =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"

/**
 * Shared "..." overflow menu rendered in app chrome. Header-level UI affordances
 * (Members, Settings, Close Project, etc.) collapse here so the top bar stops
 * scaling sideways with every new feature.
 */
export function OverflowMenu({ items, includeTheme = true }: Props) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="ghost" size="icon" aria-label="More" title="More">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        }
      />
      <Menu.Portal>
        {/* z-40 on Positioner, not Popup — see ui/tooltip.tsx for rationale. */}
        <Menu.Positioner sideOffset={4} align="end" className="z-40">
          <Menu.Popup className="min-w-48 rounded-xl border bg-popover p-1 text-popover-foreground shadow-soft-lg">
            {items.map((item) => (
              <Menu.Item key={item.id} onClick={item.onClick} className={ITEM_CLASS}>
                <item.icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Menu.Item>
            ))}
            {includeTheme && (
              <>
                {items.length > 0 && <div className="my-1 h-px bg-border" role="separator" />}
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                  <span className="text-muted-foreground">Theme</span>
                  <ThemeToggle />
                </div>
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                  <span className="text-muted-foreground">Color</span>
                  <ColorThemePicker />
                </div>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
