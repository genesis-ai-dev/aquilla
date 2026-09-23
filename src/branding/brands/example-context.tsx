import type { Brand } from "../types"
import { Mark } from "../assets/aquilla/Mark"
import { Wordmark } from "../assets/aquilla/Wordmark"
import { exampleContextData } from "./example-context.data"

export const exampleContext: Brand = {
  ...exampleContextData,
  logo: { ...exampleContextData.logo, Mark, Wordmark },
}
