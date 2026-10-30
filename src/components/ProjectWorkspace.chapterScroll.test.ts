/**
 * AQU-1758: on a book, the table reports the chapter on screen as it scrolls
 * (EditorTable's onActiveChapterChange). Scrolling is reading, not a pick:
 * Play all paused at Genesis 3:12 and the table scrolled on into Genesis 4
 * must still resume at 3:12. Only a pick in the chapter picker
 * (lib/timeline/chapter-pick `planChapterPick`) or a row of another chapter
 * clicked (`rowEndsPlayback`) may end a paused playback.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")

/** Every effect in the workspace, as its body and its dependency list. */
function effects(): { body: string; deps: string }[] {
  const out: { body: string; deps: string }[] = []
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\)/g
  for (let m = re.exec(source); m; m = re.exec(source)) out.push({ body: m[1], deps: m[2] })
  return out
}

describe("scrolling a book's table into another chapter (AQU-1758)", () => {
  it("the table's chapter report only names the chapter on screen", () => {
    const start = source.indexOf("const handleTableChapterChange = useCallback(")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf("\n  }, [])", start))
    expect(body).toContain("setChosenScopeKey(key)")
    expect(body).not.toMatch(/stopQueue|startQueue|applyChapterPick/)
  })

  it("no effect ends playback because the chapter on screen changed", () => {
    const found = effects()
    expect(found.length).toBeGreaterThan(10)
    const offenders = found.filter((e) => /chosenScopeKey/.test(e.deps) && /stopQueue\(/.test(e.body))
    expect(offenders.map((e) => e.deps)).toEqual([])
  })

  it("a row of another chapter clicked still ends a paused playback", () => {
    const start = source.indexOf("showChapterOfCellRef.current = (cellId) => {")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf("\n    }", start))
    expect(body).toMatch(/rowEndsPlayback\(/)
    expect(body).toContain("stopQueue()")
  })
})
