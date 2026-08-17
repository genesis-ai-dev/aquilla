import type { BrandLogoProps } from "../../types"
import markHref from "./mark.svg?url"

export function Mark(props: BrandLogoProps) {
  // i18n-exempt brand wordmark
  return <img src={markHref} alt="Honeycomb Studio" {...props} />
}
