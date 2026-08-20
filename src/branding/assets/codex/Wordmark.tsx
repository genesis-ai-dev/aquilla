import type { BrandLogoProps } from "../../types"
import wordmarkHref from "./wordmark.svg?url"

export function Wordmark(props: BrandLogoProps) {
  // i18n-exempt brand wordmark
  return <img src={wordmarkHref} alt="Codex Translator" {...props} />
}
