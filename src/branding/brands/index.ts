import type { Brand, BrandId } from "../types"
import { aquilla } from "./aquilla"
import { codex } from "./codex"
import { honeycomb } from "./honeycomb"
import { context } from "./context"
import { exampleHoneycomb } from "./example-honeycomb"
import { exampleContext } from "./example-context"

export const BRANDS: Record<BrandId, Brand> = {
  aquilla,
  codex,
  honeycomb,
  context,
  "example-honeycomb": exampleHoneycomb,
  "example-context": exampleContext,
}
export const BRAND_IDS = Object.keys(BRANDS) as BrandId[]
