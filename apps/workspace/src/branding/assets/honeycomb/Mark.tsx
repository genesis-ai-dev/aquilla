import type { BrandLogoProps } from "../../types"
import markHref from "./mark.svg?url"

export function Mark(props: BrandLogoProps) {
  return <img src={markHref} alt="Honeycomb Studio" {...props} />
}
