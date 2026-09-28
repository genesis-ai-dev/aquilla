import type { BrandData, BrandId } from "../types.ts"
import { aquillaData } from "./aquilla.data.ts"
import { codexData } from "./codex.data.ts"
import { honeycombData } from "./honeycomb.data.ts"
import { contextData } from "./context.data.ts"
import { exampleHoneycombData } from "./example-honeycomb.data.ts"
import { exampleContextData } from "./example-context.data.ts"

export const BRAND_DATA: Record<BrandId, BrandData> = {
  aquilla: aquillaData,
  codex: codexData,
  honeycomb: honeycombData,
  context: contextData,
  "example-honeycomb": exampleHoneycombData,
  "example-context": exampleContextData,
}

export const BRAND_DATA_IDS = Object.keys(BRAND_DATA) as BrandId[]
