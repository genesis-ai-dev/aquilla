import { z } from "zod"

/** Non-empty after trim — standard required text field. */
export const requiredString = (label: string) =>
  z.string().trim().min(1, `${label} is required`)

export const optionalString = z.string()
