import type { Brand } from "../types"
import { Mark } from "../assets/aquilla/Mark"
import { Wordmark } from "../assets/aquilla/Wordmark"
import { exampleHoneycombData } from "./example-honeycomb.data"

export const exampleHoneycomb: Brand = {
  ...exampleHoneycombData,
  logo: { ...exampleHoneycombData.logo, Mark, Wordmark },
}
