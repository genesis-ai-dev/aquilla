import type { Brand } from "../types"
import { Mark } from "../assets/acme/Mark"
import { Wordmark } from "../assets/acme/Wordmark"
import { acmeData } from "./acme.data"

export const acme: Brand = {
  ...acmeData,
  logo: { ...acmeData.logo, Mark, Wordmark },
}
