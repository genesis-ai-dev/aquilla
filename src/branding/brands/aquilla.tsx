import type { Brand } from "../types"
import { Mark } from "../assets/aquilla/Mark"
import { Wordmark } from "../assets/aquilla/Wordmark"
import { aquillaData } from "./aquilla.data"

export const aquilla: Brand = {
  ...aquillaData,
  logo: { ...aquillaData.logo, Mark, Wordmark },
}
