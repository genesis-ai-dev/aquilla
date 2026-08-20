import { z } from "zod"
import { t } from "@/lib/i18n/standalone"

/**
 * Non-empty after trim — standard required text field.
 *
 * Prefer refine over `z.string().trim().min(1)`: Zod's `.trim()` is a
 * transform, and TanStack Form's Standard Schema mapping can drop the
 * resulting field error after a re-submit (empty source/name fields then
 * look valid while sibling superRefine errors still show).
 *
 * `requiredString(label)` itself is typically called at module scope
 * (`const schema = z.object({ name: requiredString("Team name") })`), so the
 * error text must NOT be resolved eagerly there — `error` accepts a function
 * (zod v4), evaluated lazily on each validation run, so the standalone `t()`
 * call happens at validation time and reflects the locale active then.
 */
export const requiredString = (label: string) =>
  z.string().refine((val) => val.trim().length > 0, {
    error: () => t("workspace.forms.requiredField", { label }),
  })

export const optionalString = z.string()
