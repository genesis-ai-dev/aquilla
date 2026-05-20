// Inline status surface used by the auth apps to show "incorrect password",
// "check your email", etc. Stays small on purpose — for richer toasts the
// workspace SPA has its own component.

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./cn"

const alertVariants = cva(
  "relative w-full rounded-xl border px-3 py-2 text-sm",
  {
    variants: {
      tone: {
        info: "border-transparent bg-background text-foreground shadow-neu-inset",
        success:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
        error:
          "border-destructive/40 bg-destructive/10 text-destructive",
        warning:
          "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
      },
    },
    defaultVariants: {
      tone: "info",
    },
  },
)

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, tone, role = "status", ...props }, ref) => (
    <div
      ref={ref}
      role={role}
      data-slot="alert"
      data-tone={tone ?? "info"}
      className={cn(alertVariants({ tone, className }))}
      {...props}
    />
  ),
)
Alert.displayName = "Alert"
