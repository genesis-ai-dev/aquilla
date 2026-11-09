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
    expect(body.indexOf("if (film) await applyLinkVideoRef.current?.(film, activeFileId)"))
      .toBeGreaterThan(body.indexOf("recordRecordingLines(activeFileId, lines)"))
    expect(source).toContain("useEffect(() => { applyLinkVideoRef.current = applyLinkVideo }, [applyLinkVideo])")
  })
})

// AQU-2461 (review, Nov 9): the upload takes minutes for a whole episode, and
// the film write went to whichever file was open when it ended. Open another
// file meanwhile and the dropped file lost its picture, or the other file's
// film was replaced. The write is for the file the video was dropped on.
describe("a video's picture goes to the file it was dropped on", () => {
  const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
  const between = (from: string, to: string) => {
    const start = source.indexOf(from)
    expect(start).toBeGreaterThan(-1)
    return source.slice(start, source.indexOf(to, start))
  }

  it("the drop hands the film write its own file, not whichever is open by then", () => {
    const body = between("const handleAttachMediaFile = useCallback(", "\n  const handleAttachMediaUrl")
    expect(body).toContain("applyLinkVideoRef.current?.(film, activeFileId)")
  })

  it("the film write is made to the file it is given", () => {
    const apply = between("const applyLinkVideo = useCallback(", "useEffect(() => { applyLinkVideoRef.current")
    expect(apply).toMatch(/async \(url: string \| null, forFileId\?: string\)/)
    expect(apply).toContain("await writeFilmLink(url, fileId)")
    expect(apply).toContain("data: { fileId, before, after: url }")
    const write = between("const writeFilmLink = useCallback(", "const readFilmLink = useCallback(")
    expect(write).toMatch(/async \(url: string \| null, forFileId\?: string\): Promise<boolean>/)
    // The event and the pending-film note both name the given file.
    expect(write).toMatch(/emitFileVideoSet\(\{\s*projectId: project\.id,\s*fileId,/)
    expect(write).toContain("filmWrittenRef.current.set(fileId,")
    expect(write).not.toContain("fileId: activeFileId")
  })

  it("the timing note is only for the open file: its sources are the only ones known here", () => {
    const write = between("const writeFilmLink = useCallback(", "const readFilmLink = useCallback(")
    expect(write).toMatch(/const modeWillChange =\s*open &&/)
  })
})
