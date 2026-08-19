import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** WebKit maps label:hover onto the labelled control. Keep hover paint on the menu, not the FieldLabel. */
const restWhileFieldLabelHovered =
  "group-has-[[data-slot=field-label]:hover]/field:not-aria-expanded:hover:bg-transparent group-has-[[data-slot=field-label]:hover]/field:not-aria-expanded:dark:hover:bg-input/30"

/** Open/press fill — one muted→accent step, including while the pointer stays on the trigger. */
const accentFill =
  "active:bg-accent aria-expanded:bg-accent aria-pressed:bg-accent data-popup-open:bg-accent hover:active:bg-accent hover:aria-expanded:bg-accent hover:aria-pressed:bg-accent hover:data-popup-open:bg-accent dark:hover:active:bg-accent dark:hover:aria-expanded:bg-accent dark:hover:aria-pressed:bg-accent dark:hover:data-popup-open:bg-accent"

/** Keep the resting border while focused-open (base `focus-visible:border-ring` would swap it). */
const outlineOpenBorder =
  "aria-expanded:border-border aria-pressed:border-border data-popup-open:border-border aria-expanded:focus-visible:border-border aria-pressed:focus-visible:border-border data-popup-open:focus-visible:border-border dark:aria-expanded:border-input dark:aria-pressed:border-input dark:data-popup-open:border-input"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-none outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_8%)] active:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] hover:active:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] aria-expanded:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] hover:aria-expanded:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] data-popup-open:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] hover:data-popup-open:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)]",
        outline: [
          "border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
          "group-has-[[data-slot=field-label]:hover]/field:not-aria-expanded:hover:bg-background group-has-[[data-slot=field-label]:hover]/field:not-aria-expanded:dark:hover:bg-input/30",
          accentFill,
          outlineOpenBorder,
        ].join(" "),
        secondary: [
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
          "active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] hover:active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] hover:aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] data-popup-open:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] hover:data-popup-open:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)]",
        ].join(" "),
        ghost: [
          "hover:bg-muted hover:text-foreground dark:hover:bg-input/50",
          restWhileFieldLabelHovered,
          accentFill,
        ].join(" "),
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 active:bg-destructive/30 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:active:bg-destructive/40 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
