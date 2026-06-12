import type { ComponentType } from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemeToggle } from "@/branding/ThemeMode"
import { ColorThemePicker } from "@/branding/ColorTheme"

export interface OverflowMenuItem {
  id: string
  type?: "item" | "separator"
  label?: string
  icon?: ComponentType<{ className?: string }>
  onClick?: () => void
  disabled?: boolean
}

interface Props {
  items: OverflowMenuItem[]
  /** When true (default), appends a Theme row at the bottom. */
  includeTheme?: boolean
}

/**
 * Shared "..." overflow menu rendered in app chrome. Header-level UI affordances
 * (Members, Settings, Close Project, etc.) collapse here so the top bar stops
 * scaling sideways with every new feature.
 */
export function OverflowMenu({ items, includeTheme = true }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="More" title="More">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          {items.map((item) =>
            item.type === "separator" ? (
              <DropdownMenuSeparator key={item.id} />
            ) : (
              <DropdownMenuItem
                key={item.id}
                disabled={item.disabled}
                onClick={item.onClick}
              >
                {item.icon && <item.icon className="h-4 w-4" />}
                <span>{item.label}</span>
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuGroup>
        {includeTheme && (
          <>
            {items.some((item) => item.type !== "separator") && (
              <DropdownMenuSeparator />
            )}
            {/* Theme rows host interactive controls that shouldn't close the
                menu on click, so they stay plain rows rather than menu items. */}
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
