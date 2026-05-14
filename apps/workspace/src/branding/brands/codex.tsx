import type { Brand } from "../types"
import { Mark } from "../assets/codex/Mark"
import { Wordmark } from "../assets/codex/Wordmark"
import { codexData } from "./codex.data"

export const codex: Brand = {
  ...codexData,
  logo: { ...codexData.logo, Mark, Wordmark },
}
