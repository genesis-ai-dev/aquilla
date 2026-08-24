"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      layout: {
        /** Stacked above a control when not wrapped in Field (Field supplies gap). */
        stacked: "mb-1.5",
        /** Beside a control (checkbox row, Field + FieldLabel, horizontal flex). */
        inline: "",
      },
    },
    defaultVariants: {
      layout: "stacked",
    },
  }
)

const POPUP_TRIGGER_SLOTS = new Set([
  "select-trigger",
  "combobox-trigger",
  "popover-trigger",
  "dropdown-menu-trigger",
  "dialog-trigger",
  "sheet-trigger",
  "multi-select-combobox-trigger",
  "collapsible-trigger",
])

const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch"])

/** Buttons/selects that open a popup — not checkboxes, switches, or text fields. */
function isPopupOpeningControl(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return false
  }
  const role = el.getAttribute("role")
  if (role && TOGGLE_ROLES.has(role)) return false
  if (el instanceof HTMLSelectElement) return true
  const slot = el.getAttribute("data-slot")
  if (slot && POPUP_TRIGGER_SLOTS.has(slot)) return true
  const hasPopup = el.getAttribute("aria-haspopup")
  if (hasPopup && hasPopup !== "false") return true
  return role === "combobox"
}

function associatedControl(label: HTMLLabelElement): Element | null {
  if (label.htmlFor) {
    return document.getElementById(label.htmlFor)
  }
  return label.querySelector(
    "button, input, select, textarea, [role='combobox'], [role='checkbox'], [role='radio'], [role='switch']",
  )
}

function Label({
  className,
  layout,
  onClick,
  ...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) {
  return (
    <label
      data-slot="label"
      className={cn(labelVariants({ layout }), className)}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        const control = associatedControl(event.currentTarget)
        if (!control || !isPopupOpeningControl(control)) return
        const target = event.target
        if (
          target instanceof Node &&
          (control === target || control.contains(target))
        ) {
          return
        }
        event.preventDefault()
      }}
    />
  )
}

export { Label, labelVariants }
