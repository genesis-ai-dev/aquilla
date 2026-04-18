import type { Brand, BrandId } from "../types"
import { codex } from "./codex"
import { honeycomb } from "./honeycomb"
import { context } from "./context"

export const BRANDS: Record<BrandId, Brand> = { codex, honeycomb, context }
export const BRAND_IDS = Object.keys(BRANDS) as BrandId[]
