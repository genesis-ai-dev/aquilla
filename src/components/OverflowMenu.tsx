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
  /**
   * Turn the "…" into a NAMED menu. AQU-646 stage 6: the timeline's Sources
   * menu is a labelled dropdown, not an overflow — it is the primary way to
   * attach a film, audio cues or a character sheet to a file, so hiding it
   * behind an ellipsis would make three discoverable buttons undiscoverable.
   * Everything else about the menu is identical, which is why this is a prop
   * rather than a second component.
   */
  triggerLabel?: string
  triggerIcon?: ComponentType<{ className?: string }>
  /** A count carried on the TRIGGER, so it is visible without opening the
   *  menu. The character check's disagreement count lives here: putting it on
   *  an item would make the thing you wanted a badge for one click further
   *  away than it already is. */
  triggerBadge?: ReactNode
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
  triggerLabel,
  triggerIcon,
  triggerBadge,
}: Props) {
  if (items.length === 0) return null

  const TriggerIcon = triggerIcon ?? MoreHorizontal
  const trigger = (
    <DropdownMenuTrigger
      render={
        <Button
          ref={triggerRef}
          variant={triggerVariant}
          // A labelled trigger cannot be an icon-sized square.
          size={triggerLabel ? (triggerSize === "icon" ? "sm" : triggerSize) : triggerSize}
          className={triggerClassName}
          aria-label={triggerLabel ?? ariaLabel}
          data-testid={testId}
        >
          <TriggerIcon className="h-4 w-4" />
          {triggerLabel}
          {triggerBadge}
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
