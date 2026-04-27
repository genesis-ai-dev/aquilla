import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import * as Y from "yjs"
import { TranslatedEditor } from "./TranslatedEditor"
import type { WordTiming } from "@/lib/codex-editor/types"

function makeFragment(text: string): Y.XmlFragment {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment("frag")
  const para = new Y.XmlElement("paragraph")
  para.insert(0, [new Y.XmlText(text)])
  frag.insert(0, [para])
  return frag
}

const TIMINGS: WordTiming[] = [
  { word: "hello", t0: 0, t1: 1, start: 0, end: 5 },
  { word: "world", t0: 1, t1: 2, start: 6, end: 11 },
]

afterEach(cleanup)

describe("TranslatedEditor karaoke decoration", () => {
  it("paints the active word at currentTime=0.2 (first word)", async () => {
    const { container } = render(
      <TranslatedEditor
        fragment={makeFragment("hello world")}
        audioTimings={TIMINGS}
        audioCurrentTime={0.2}
      />
    )
    await new Promise((r) => setTimeout(r, 0))
    const active = container.querySelector(".karaoke-active")
    expect(active?.textContent).toBe("hello")
  })

  it("moves the decoration when currentTime crosses a word boundary", async () => {
    const { container, rerender } = render(
      <TranslatedEditor
        fragment={makeFragment("hello world")}
        audioTimings={TIMINGS}
        audioCurrentTime={0.5}
      />
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector(".karaoke-active")?.textContent).toBe("hello")

    rerender(
      <TranslatedEditor
        fragment={makeFragment("hello world")}
        audioTimings={TIMINGS}
        audioCurrentTime={1.5}
      />
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector(".karaoke-active")?.textContent).toBe("world")
  })

  it("renders no decoration when there are no timings", async () => {
    const { container } = render(
      <TranslatedEditor
        fragment={makeFragment("hello world")}
        audioCurrentTime={0.5}
      />
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector(".karaoke-active")).toBeNull()
  })
})
