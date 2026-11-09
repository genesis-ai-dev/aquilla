/**
 * A video dropped or chosen on the "No media on this file yet" card keeps its
 * picture as the file's film (attach-media.role.test covers the attach). The
 * workspace asks for the picture only when the file has no film yet, and sets
 * it through the same write as Link a film, so the timing note, the Undo step
 * and a refused write's toast all come with it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

describe("a video's picture kept from the empty-file card", () => {
  const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
  const start = source.indexOf("const handleAttachMediaFile = useCallback(")
  const body = source.slice(start, source.indexOf("\n  const ", start + 10))

  it("asks for the picture only when the file has no film yet", () => {
    expect(body).toMatch(/\{ keepPicture: !activeFile\?\.coreMediaUrl[,}]/)
  })

  it("sets it through Link a film's own write, after the lines are made", () => {
    expect(body.indexOf("if (film) await applyLinkVideoRef.current?.(film)"))
      .toBeGreaterThan(body.indexOf("recordRecordingLines(activeFileId, lines)"))
    expect(source).toContain("useEffect(() => { applyLinkVideoRef.current = applyLinkVideo }, [applyLinkVideo])")
  })
})
