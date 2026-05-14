// Vertical label-over-input row used across every auth form. Lets the
// individual app files stay tight: <FormRow label="Email" htmlFor="email">…</FormRow>.

import * as React from "react"
import { cn } from "./cn"
import { Label } from "./label"

export interface FormRowProps {
  label: React.ReactNode
  htmlFor: string
  /** Inline hint text below the input (e.g. "8+ characters"). */
  hint?: React.ReactNode
  /** Per-field error message — replaces the hint when present. */
  error?: React.ReactNode
  className?: string
  children: React.ReactNode
}

export function FormRow({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: FormRowProps) {
  const messageId = `${htmlFor}-msg`
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {(error || hint) && (
        <p
          id={messageId}
          data-slot={error ? "form-error" : "form-hint"}
          className={cn(
            "text-xs",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  )
}
