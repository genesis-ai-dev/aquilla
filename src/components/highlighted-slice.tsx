import type { ComponentProps, ReactNode } from "react"
import { HighlightedText, type HealthDisplaySpan, type RangeHighlight } from "./HighlightedText"

/**
 * One slice of a row's text around its key terms (AQU-2655). A slice with no
 * finding and no health wash on it is the `<span>` `HighlightedText` would
 * draw anyway, drawn without mounting a `HighlightedText` for it: a row with
 * key terms is cut into a piece per term and one per gap, and most of them
 * carry nothing to decorate.
 */
export function highlightedSlice(
  key: string,
  text: string,
  ranges: RangeHighlight[],
  healthSpans: HealthDisplaySpan[] | undefined,
  onRangeClick: ComponentProps<typeof HighlightedText>["onRangeClick"],
): ReactNode {
  if (ranges.length === 0 && (healthSpans === undefined || healthSpans.length === 0)) {
    return <span key={key}>{text}</span>
  }
  return (
    <HighlightedText
      key={key}
      text={text}
      ranges={ranges}
      healthSpans={healthSpans}
      onRangeClick={onRangeClick}
    />
  )
}
