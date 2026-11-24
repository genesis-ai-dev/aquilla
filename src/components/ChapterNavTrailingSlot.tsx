/* eslint-disable react-refresh/only-export-components -- a context, its outlet and the outlet's one shared element belong in one file */
import { createContext, useContext, type ReactNode } from "react"

/**
 * The editor table's chapter-row toolbar, handed over by context instead of
 * as a prop (AQU-2654, decision 0013 "a row's props are stable").
 *
 * The workspace builds the toolbar element on every render. As the table's
 * `chapterNavTrailing` prop that made a new prop per workspace render, so the
 * memoized table could never bail out. The workspace now provides the element
 * here and passes the table `CHAPTER_NAV_TRAILING_OUTLET` — one element for
 * the life of the page — so a workspace render re-renders the toolbar (through
 * the outlet) and not the table around it.
 */
export const ChapterNavTrailingContext = createContext<ReactNode>(null)

function ChapterNavTrailingOutlet() {
  return <>{useContext(ChapterNavTrailingContext)}</>
}

export const CHAPTER_NAV_TRAILING_OUTLET: ReactNode = <ChapterNavTrailingOutlet />
