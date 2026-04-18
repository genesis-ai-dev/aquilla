import type { BrandLogoProps } from "../../types"
import wordmarkHref from "./wordmark.svg?url"

export function Wordmark(props: BrandLogoProps) {
  return <img src={wordmarkHref} alt="Codex Translator" {...props} />
}
