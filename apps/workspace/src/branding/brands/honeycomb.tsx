import type { Brand } from "../types"
import { Mark } from "../assets/honeycomb/Mark"
import { Wordmark } from "../assets/honeycomb/Wordmark"
import { honeycombData } from "./honeycomb.data"

export const honeycomb: Brand = {
  ...honeycombData,
  logo: { ...honeycombData.logo, Mark, Wordmark },
}
