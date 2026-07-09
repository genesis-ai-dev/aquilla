import { z } from "zod"

/**
 * Non-empty after trim — standard required text field.
 *
 * Prefer refine over `z.string().trim().min(1)`: Zod's `.trim()` is a
 * transform, and TanStack Form's Standard Schema mapping can drop the
 * resulting field error after a re-submit (empty source/name fields then
 * look valid while sibling superRefine errors still show).
 */
export const requiredString = (label: string) =>
  z.string().refine((val) => val.trim().length > 0, {
    message: `${label} is required`,
  })

export const optionalString = z.string()
