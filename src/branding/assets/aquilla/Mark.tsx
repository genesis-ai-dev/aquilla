import type { BrandLogoProps } from "../../types"
import markHref from "./mark-purple-dark.svg?url"

export function Mark(props: BrandLogoProps) {
  return <img src={markHref} alt="Aquilla" {...props} />
}
