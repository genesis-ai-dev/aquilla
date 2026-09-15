import { useId, useState, type ComponentType, type ReactNode, type Ref } from "react"
import type { VariantProps } from "class-variance-authority"
import { Info, MoreHorizontal } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
   * Explanation behind a small info icon at the end of the row: hover or
   * focus shows it as a tooltip, tap or click toggles it for touch users, and
   * it is wired to the item through aria-describedby so assistive tech reads
   * it as the item's description. Use it when the label alone cannot say what
   * the item does (AQU-1078: "Draft as you read" needs its guarantees stated
   * somewhere, but not as a paragraph inside the menu).
   */
  description?: string
  onClick?: () => void
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  destructive?: boolean
  testId?: string
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
function ItemHint({ id, text }: { id: string; text: string }) {
  // Controlled so a click can toggle it: Base UI tooltips open on hover and
  // focus only, and a touch user has neither. The click stops at the icon so
  // it never activates the menu item around it.
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* aria-hidden keeps the text out of the item's accessible NAME; an
          aria-describedby reference still reads hidden nodes, so it lands in
          the DESCRIPTION as intended. */}
      <span id={id} aria-hidden="true" className="sr-only">
        {text}
      </span>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          delay={200}
          render={
            <span
              aria-hidden="true"
              className="ml-auto inline-flex shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
            />
          }
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen((value) => !value)
          }}
        >
          <Info className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs leading-snug">
          {text}
        </TooltipContent>
      </Tooltip>
    </>
  )
}

function OverflowMenuPanel({ items }: { items: OverflowMenuItem[] }) {
  const menuId = useId()
  // The hint text lives in a visually hidden span and reaches the item through
  // aria-describedby, so the accessible NAME stays the bare label and the copy
  // lands in the DESCRIPTION. Sighted users get the same text from the icon.
  const describedBy = (item: OverflowMenuItem) =>
    item.description ? `${menuId}-${item.id}-description` : undefined
  const body = (item: OverflowMenuItem) => (
    <>
      {item.icon && <item.icon className="h-4 w-4" />}
      <span className="flex-1">{item.label}</span>
      {item.description && <ItemHint id={describedBy(item)!} text={item.description} />}
      {item.badge}
    </>
  )
  // DropdownMenuContent sizes itself to its anchor with a 192px floor. The
  // info icon and the check indicator share the row with the label, so a
  // panel that carries a hint gets a slightly wider floor to keep short labels
  // on one line. Menus without a hint render exactly as before.
  const hasDescription = items.some((item) => item.description)
  return (
    <DropdownMenuContent align="end" className={hasDescription ? "min-w-56" : "min-w-48"}>
      <DropdownMenuGroup>
        {items.map((item) =>
          item.type === "separator" ? (
            <DropdownMenuSeparator key={item.id} />
          ) : item.type === "checkbox" ? (
            <DropdownMenuCheckboxItem
              key={item.id}
              checked={item.checked}
              disabled={item.disabled}
              data-testid={item.testId}
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
              data-testid={item.testId}
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
