import type { Brand, BrandId } from "../types"
import { aquilla } from "./aquilla"
import { codex } from "./codex"
import { honeycomb } from "./honeycomb"
import { context } from "./context"

export const BRANDS: Record<BrandId, Brand> = { aquilla, codex, honeycomb, context }
export const BRAND_IDS = Object.keys(BRANDS) as BrandId[]
