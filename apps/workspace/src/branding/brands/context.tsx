import type { Brand } from "../types"
import { Mark } from "../assets/context/Mark"
import { Wordmark } from "../assets/context/Wordmark"
import { contextData } from "./context.data"

export const context: Brand = {
  ...contextData,
  logo: { ...contextData.logo, Mark, Wordmark },
}
