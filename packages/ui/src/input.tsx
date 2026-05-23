import * as React from "react"
import { cn } from "./cn"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          "h-9 w-full min-w-0 rounded-xl border border-input bg-input/40 px-3 py-1 text-base transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40 md:text-sm [label+&]:mt-2 [[data-slot=label]+&]:mt-2",
          className,
        )}
        {...props}
      />
    )
  },
)
Input.displayName = "Input"
