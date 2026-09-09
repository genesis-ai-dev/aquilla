import { z } from "zod"

export const checkoutSchema = z.object({
  kind: z.enum(["field", "addon"]),
  billingInterval: z.enum(["monthly", "annual"]).default("monthly"),
  packs: z.number().int().min(1).max(20).optional(),
})
