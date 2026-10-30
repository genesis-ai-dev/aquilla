import { Fragment, useId, type ComponentType, type ReactNode, type Ref } from "react"
import type { VariantProps } from "class-variance-authority"
import { MoreHorizontal } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { toSections } from "./overflow-menu-sections"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface OverflowMenuItem {
  id: string
  /**
   * `label` names the items that follow it instead of being one of them
   * (AQU-358). Everything from a `label` up to the next one renders as its own
   * group with that heading, so a menu that merged several smaller menus can
   * say what each part of it is for rather than leaving a reader to infer it
   * from anonymous separator lines.
   */
  type?: "item" | "checkbox" | "separator" | "label"
  label?: string
  icon?: ComponentType<{ className?: string }>
  /** Optional trailing badge (e.g. check-file finding count). */
  badge?: ReactNode
  /**
   * Explanation behind a small (i) at the end of the row: a click opens it in
   * place under the label and a second click shuts it (AQU-2260), and it is
   * wired to the item through aria-describedby so assistive tech reads it as
   * the item's description. Use it when the label alone cannot say what the
   * item does (AQU-1078: "Draft as you read" needs its guarantees stated
   * somewhere, but not as a paragraph inside the menu).
   */
  description?: string
  /**
   * Why a disabled item is disabled, behind the row's (i): a click opens it in
   * place (AQU-2260; it was a hover). The row stays clean, greyed out with no
   * inline text until asked (Sam, Oct 5: "track editing off" beside "Attach
   * captions" was too many words for one row), and the reason reaches
   * assistive tech as the item's description.
   */
  disabledReason?: string
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
/**
 * A row's icon and label, with an (i) when the row has something to explain:
 * what it does (`description`), or why it is greyed out (`disabledReason`).
 * AQU-2260 (Sam, Oct 29): a click on the (i) opens the text in place, under
 * the label, inside the menu, and a second click shuts it; it never runs the
 * row, and hovering shows nothing. It used to be a tooltip that also toggled on
 * click, floating to the right. The text is the row's accessible description,
 * so a screen reader hears it whether or not it is open.
 */
function ItemBody({ item, textId }: { item: OverflowMenuItem; textId: string | undefined }) {
  const t = useT()
  const [open, toggle] = useInfoOpen()
  const why = item.disabled ? item.disabledReason : undefined
  const texts = [item.description, why].filter((x): x is string => Boolean(x))
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          {item.icon && <item.icon className="h-4 w-4" />}
          <span className="flex-1">{item.label}</span>
          {textId && texts.length > 0 && (
            // A disabled row takes no pointer events; its (i) takes them back.
            <span className="pointer-events-auto ms-auto" data-testid={item.testId && `${item.testId}-info`}>
              <InfoToggle
                open={open}
                onToggle={toggle}
                label={t("common.aboutAria", { name: item.label ?? "" })}
                controls={textId}
              />
            </span>
          )}
        </span>
        {textId && texts.length > 0 && (
          <InfoReveal
            open={open}
            id={textId}
            testId={item.testId && `${item.testId}-reason`}
            className="max-w-64 text-xs leading-snug font-normal text-muted-foreground"
          >
            <span className="flex flex-col gap-1 pt-0.5">
              {texts.map((text) => <span key={text}>{text}</span>)}
            </span>
          </InfoReveal>
        )}
      </span>
      {item.badge}
    </>
  )
}

function OverflowMenuPanel({ items }: { items: OverflowMenuItem[] }) {
  const menuId = useId()
  // The (i)'s text reaches the item through aria-describedby, so the
  // accessible NAME stays the bare label (set outright, since the (i) button
  // inside the row would otherwise join it) and the text is its DESCRIPTION.
  const reason = (item: OverflowMenuItem) => (item.disabled ? item.disabledReason : undefined)
  const describedBy = (item: OverflowMenuItem) =>
    item.description || reason(item) ? `${menuId}-${item.id}-description` : undefined
  const body = (item: OverflowMenuItem) => <ItemBody item={item} textId={describedBy(item)} />
  // DropdownMenuContent sizes itself to its anchor with a 192px floor. The
  // info icon and the check indicator share the row with the label, so a
  // panel that carries a hint gets a slightly wider floor to keep short labels
  // on one line. Menus without a hint render exactly as before.
  const hasDescription = items.some((item) => item.description)
  // A panel with status badges ("linked", "not imported", "track editing off")
  // takes its content's width instead of its anchor's: at the anchor's width a
  // badge squeezed its row's label onto two lines (Sam, Oct 5, the timeline's
  // Sources menu). Capped so a long label still wraps inside the window.
  const hasBadge = items.some((item) => item.badge)
  const row = (item: OverflowMenuItem) =>
    item.type === "separator" ? (
      <DropdownMenuSeparator key={item.id} />
    ) : item.type === "checkbox" ? (
      <DropdownMenuCheckboxItem
        key={item.id}
        checked={item.checked}
        disabled={item.disabled}
        data-testid={item.testId}
        aria-describedby={describedBy(item)}
        aria-label={describedBy(item) ? item.label : undefined}
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
        aria-label={describedBy(item) ? item.label : undefined}
        onClick={item.onClick}
      >
        {body(item)}
      </DropdownMenuItem>
    )
  return (
    <DropdownMenuContent align="end" className={cn(
      hasDescription ? "min-w-56" : "min-w-48",
      hasBadge && "w-max max-w-[min(24rem,calc(100vw-2rem))]",
    )}>
      {toSections(items).map((section) => (
        <Fragment key={section.id}>
          {section.dividerAbove && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            {section.heading !== undefined && (
              <DropdownMenuLabel>{section.heading}</DropdownMenuLabel>
            )}
            {section.items.map(row)}
          </DropdownMenuGroup>
        </Fragment>
      ))}
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
