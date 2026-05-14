// Minimal Button — native <button> with shadcn-style class variants.
//
// The workspace SPA's src/components/ui/button.tsx wraps @base-ui/react's
// Button primitive for richer keyboard / a11y semantics. The standalone apps
// shipping under apps/<slug>/ don't need that breadth yet, so this package
// stays dep-light. When 3b's UI PR lands, swap this for the rich variant.

import * as React from "react"
import { cn } from "./utils"

type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link"
type Size = "default" | "sm" | "lg" | "icon"

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  outline: "border border-input bg-background hover:bg-muted",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-muted hover:text-foreground",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
  link: "text-primary underline-offset-4 hover:underline",
}

const SIZE_CLASSES: Record<Size, string> = {
  default: "h-8 gap-1.5 px-2.5",
  sm: "h-7 gap-1 px-2.5 text-[0.8rem]",
  lg: "h-9 gap-1.5 px-3",
  icon: "size-8",
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      data-slot="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  )
})
