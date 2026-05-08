import type { BrandData, BrandId } from "../types"
import { aquillaData } from "./aquilla.data"
import { codexData } from "./codex.data"
import { honeycombData } from "./honeycomb.data"
import { contextData } from "./context.data"

export const BRAND_DATA: Record<BrandId, BrandData> = {
  aquilla: aquillaData,
  codex: codexData,
  honeycomb: honeycombData,
  context: contextData,
}

export const BRAND_DATA_IDS = Object.keys(BRAND_DATA) as BrandId[]
