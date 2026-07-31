import type { ComponentType, ReactNode, Ref } from "react"
import type { VariantProps } from "class-variance-authority"
import { MoreHorizontal } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"

export interface OverflowMenuItem {
  id: string
  type?: "item" | "separator"
  label?: string
  icon?: ComponentType<{ className?: string }>
  /** Optional trailing badge (e.g. check-file finding count). */
  badge?: ReactNode
  onClick?: () => void
  disabled?: boolean
  destructive?: boolean
}

interface Props {
  items: OverflowMenuItem[]
  /** Ghost icon in app chrome (default) or outline for editor toolbars. */
  triggerVariant?: "ghost" | "outline"
  triggerSize?: NonNullable<VariantProps<typeof buttonVariants>["size"]>
  triggerClassName?: string
  tooltip?: string
  ariaLabel?: string
  testId?: string
  /** Skip tooltip wrapper so the trigger can sit inside a ButtonGroup. */
  inButtonGroup?: boolean
  /** Anchor for popovers opened from this menu (e.g. View settings). */
  triggerRef?: Ref<HTMLButtonElement>
}

/**
 * Shared "..." overflow menu rendered in app chrome. Header-level UI affordances
 * (Members, Settings, Close Project, etc.) collapse here so the top bar stops
 * scaling sideways with every new feature.
 */
function OverflowMenuPanel({ items }: { items: OverflowMenuItem[] }) {
  return (
    <DropdownMenuContent align="end" className="min-w-48">
      <DropdownMenuGroup>
        {items.map((item) =>
          item.type === "separator" ? (
            <DropdownMenuSeparator key={item.id} />
          ) : (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              variant={item.destructive ? "destructive" : "default"}
              onClick={item.onClick}
            >
              {item.icon && <item.icon className="h-4 w-4" />}
              <span className="flex-1">{item.label}</span>
              {item.badge}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

export function OverflowMenu({
  items,
  triggerVariant = "ghost",
  triggerSize = "icon",
  triggerClassName,
  tooltip = "More",
  ariaLabel = "More",
  testId,
  inButtonGroup = false,
  triggerRef,
}: Props) {
  if (items.length === 0) return null

  const trigger = (
    <DropdownMenuTrigger
      render={
        <Button
          ref={triggerRef}
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      }
    />
  )

  return (
    <DropdownMenu>
      {inButtonGroup ? trigger : (
        <AppTooltip content={tooltip}>
          {trigger}
        </AppTooltip>
      )}
      <OverflowMenuPanel items={items} />
    </DropdownMenu>
  )
}
