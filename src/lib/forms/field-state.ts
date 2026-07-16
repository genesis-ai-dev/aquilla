import type { AnyFieldApi } from "@tanstack/react-form"

/**
 * Whether to show inline validation for a TanStack Form field.
 * Errors appear after blur/touch or after any submit attempt — submit buttons
 * stay enabled so users can click and see what's wrong.
 */
export function isFieldInvalid(field: AnyFieldApi): boolean {
  const attempted = field.form.state.submissionAttempts > 0
  return (field.state.meta.isTouched || attempted) && !field.state.meta.isValid
}
