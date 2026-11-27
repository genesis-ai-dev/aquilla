/**
 * Import map D#15: the film error card offered "Change film" to every role. A
 * contributor or reviewer could type an address and learn only on Save, by
 * toast, that they needed project lead access. The card now gets its Change
 * film button only under the same gate as Link a film (`file.video.set`);
 * everyone else gets Retry. MediaVideoPane.test covers the card itself.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

describe("the film error card's Change film (import map D#15)", () => {
  it("is passed only to someone who may link a film", () => {
    const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    const pane = source.slice(source.indexOf("<MediaVideoPane"), source.indexOf("/>", source.indexOf("<MediaVideoPane")))
    expect(pane).toMatch(/onChangeVideo=\{canPerform\("file\.video\.set", [^)]*\)\s*\?\s*\(\) => setLinkVideoOpen\(true\) : undefined\}/)
  })
})
