import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { TranslatedEditor } from "./TranslatedEditor"
import type { DirectionMode, TextDirection } from "@/lib/text-direction"

// AQU-2181: the smart-edits "Ask AI for edits" button parks in the slack left
// after the cell's last line, so it has to sit on the side the text ENDS on.
// It was pinned to `right-1` in every cell, which is the empty side only in a
// left-to-right cell — in a right-to-left cell the lines end on the left, so
// the button covered the translator's own text.
//
// `dir` is applied to the ProseMirror node and these overlays are its
// siblings, so they do not inherit it: the side is chosen from the resolved
// direction held in React state. The positioning class is the only observable
// of that choice under happy-dom (no layout engine, no compiled Tailwind).

const ARABIC = "في البدء خلق الله السماوات والأرض"
const LATIN = "In the beginning God created the heavens and the earth"

function renderAskAi(args: {
  initialPlain: string
  textDirection: TextDirection
  directionMode?: DirectionMode
}): { side: string; dir: string | null } {
  const { unmount } = render(
    <TranslatedEditor
      cellId="cell-1"
      initialPlain={args.initialPlain}
      initialHtml={`<p>${args.initialPlain}</p>`}
      onCommit={vi.fn()}
      textDirection={args.textDirection}
      directionMode={args.directionMode}
      onAskLlmEdits={vi.fn()}
    />,
  )
  const button = document.querySelector('[data-testid="smart-edit-ask-ai"]') as HTMLElement
  expect(button).toBeTruthy()
  const classes = button.className.split(/\s+/)
  const dir = button.getAttribute("dir")
  unmount()
  // Exactly one horizontal inset, so the two can never fight.
  const sides = ["left-1", "right-1"].filter((side) => classes.includes(side))
  expect(sides).toHaveLength(1)
  return { side: sides[0], dir }
}

describe("TranslatedEditor — Ask AI button never covers the text (AQU-2181)", () => {
  it("parks on the side the text ends on, in every direction the lane can resolve to", () => {
    const cases: {
      why: string
      args: Parameters<typeof renderAskAi>[0]
      side: string
      dir: TextDirection
    }[] = [
      {
        why: "left-to-right lane: unchanged from before the fix",
        args: { initialPlain: LATIN, textDirection: "ltr" },
        side: "right-1",
        dir: "ltr",
      },
      {
        why: "right-to-left lane: mirrored clear of the text",
        args: { initialPlain: ARABIC, textDirection: "rtl" },
        side: "left-1",
        dir: "rtl",
      },
      {
        why: "auto mode follows the text, not the lane default (right-to-left content)",
        args: { initialPlain: ARABIC, textDirection: "ltr", directionMode: "auto" },
        side: "left-1",
        dir: "rtl",
      },
      {
        why: "auto mode follows the text, not the lane default (left-to-right content)",
        args: { initialPlain: LATIN, textDirection: "rtl", directionMode: "auto" },
        side: "right-1",
        dir: "ltr",
      },
    ]

    // One comparison over every case, so a regression on either axis shows
    // up for all four rows rather than stopping at the first.
    expect(cases.map(({ why, args }) => ({ why, ...renderAskAi(args) }))).toEqual(
      cases.map(({ why, side, dir }) => ({ why, side, dir })),
    )
  })
})
