import { useId, type ComponentType, type ReactNode, type Ref } from "react"
import type { VariantProps } from "class-variance-authority"
import { MoreHorizontal } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface OverflowMenuItem {
  id: string
  type?: "item" | "checkbox" | "separator"
  label?: string
  icon?: ComponentType<{ className?: string }>
  /** Optional trailing badge (e.g. check-file finding count). */
  badge?: ReactNode
  /**
   * One-line explanation rendered under the label and exposed as the item's
   * accessible description. Use it when the label alone cannot say what the
   * item does (AQU-1078: "Draft as you read" needs its guarantees spelled out
   * where the user reads them, not in a hover tooltip a touch user never sees).
   */
  description?: string
  onClick?: () => void
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  destructive?: boolean
}

interface Props {
  items: OverflowMenuItem[]
  /** Ghost icon in app chrome (default) or outline for editor toolbars. */
  triggerVariant?: "ghost" | "outline"
  triggerSize?: NonNullable<VariantProps<typeof buttonVariants>["size"]>
  triggerClassName?: string
  ariaLabel?: string
  testId?: string
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
  const menuId = useId()
  // The description sits inside the item so it reads as part of it, but it is
  // wired through aria-describedby (and hidden from name-from-content) so the
  // accessible NAME stays the bare label and the copy lands in the DESCRIPTION.
  const describedBy = (item: OverflowMenuItem) =>
    item.description ? `${menuId}-${item.id}-description` : undefined
  const body = (item: OverflowMenuItem) => (
    <>
      {item.icon && <item.icon className="h-4 w-4" />}
      {item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{item.label}</span>
          <span
            id={describedBy(item)}
            aria-hidden="true"
            className="text-xs font-normal text-muted-foreground whitespace-normal"
          >
            {item.description}
          </span>
        </span>
      ) : (
        <span className="flex-1">{item.label}</span>
      )}
      {item.badge}
    </>
  )
  // DropdownMenuContent sizes itself to its anchor with a 192px floor and clips
  // overflow, so a wrapping description cannot widen it on its own. Give the
  // panel a wider floor when any item carries one; the description then wraps
  // to the width it is given instead of squeezing the label into two lines.
  const hasDescription = items.some((item) => item.description)
  return (
    <DropdownMenuContent align="end" className={hasDescription ? "min-w-80" : "min-w-48"}>
      <DropdownMenuGroup>
        {items.map((item) =>
          item.type === "separator" ? (
            <DropdownMenuSeparator key={item.id} />
          ) : item.type === "checkbox" ? (
            <DropdownMenuCheckboxItem
              key={item.id}
              checked={item.checked}
              disabled={item.disabled}
              aria-describedby={describedBy(item)}
              onCheckedChange={(checked) => item.onCheckedChange?.(checked)}
            >
              {body(item)}
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              variant={item.destructive ? "destructive" : "default"}
              aria-describedby={describedBy(item)}
              onClick={item.onClick}
            >
              {body(item)}
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
  ariaLabel = "More",
  testId,
  triggerRef,
  triggerLabel,
  triggerIcon,
  triggerBadge,
}: Props) {
  if (items.length === 0) return null

  const TriggerIcon = triggerIcon ?? MoreHorizontal

  return (
    <DropdownMenu>
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
      <OverflowMenuPanel items={items} />
    </DropdownMenu>
  )
}
