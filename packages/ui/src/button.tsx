// Plain-HTML button primitive for the standalone auth apps. Mirrors the
// shape/variants of src/components/ui/button.tsx but drops the
// @base-ui/react dependency so apps/login/signup/reset don't have to pull
// it in. When Phase 3a extracts the workspace SPA into apps/workspace/,
// this can be re-aligned with the base-ui version (or the workspace can
// keep its own variant).

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { cn } from "./cn"
import { buttonVariants } from "./button-variants"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, fullWidth, type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        data-slot="button"
        className={cn(buttonVariants({ variant, size, fullWidth, className }))}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"
