import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { filesToProjectEntries } from "./file-entries"
import {
  buildParatextPtxprintZip,
  PARATEXT_BOOK_PATH,
  PTXPRINT_HELPER_PATH,
} from "../parsers/__fixtures__/paratext-ptxprint-zip"

/** The reported export, as real bytes — no stubbing of JSZip. */
function exportWithUnreadableMember(member: string): File {
  return new File([buildParatextPtxprintZip(member)], "sibtatar.zip")
}

describe("AQU-1406 — an unreadable support member does not fail a Paratext ZIP", () => {
  it("skips a PTXprint helper with bad size metadata and imports every book", async () => {
    const entries = await filesToProjectEntries([exportWithUnreadableMember(PTXPRINT_HELPER_PATH)])

    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "Settings.xml",
      "01GENSibtatar.SFM",
      PARATEXT_BOOK_PATH,
    ]))
    expect(entries.map((entry) => entry.name)).not.toContain(PTXPRINT_HELPER_PATH)
    expect(entries.skippedEntries).toEqual([
      { name: PTXPRINT_HELPER_PATH, reason: "skipped (not scripture content)" },
    ])
    // The package artifact still holds the original bytes, helper included.
    expect(entries.sourceArtifact?.name).toBe("sibtatar.zip")
  })

  it("preserves the uploaded export byte-for-byte, skipped helper included", async () => {
    const bytes = buildParatextPtxprintZip(PTXPRINT_HELPER_PATH)

    const entries = await filesToProjectEntries([new File([bytes], "sibtatar.zip")])
    const preserved = await entries.sourceArtifact!.bytes()

    // Round-trip export re-reads the original archive, so skipping a member for
    // import must not rewrite the package. (Its *content* stays unextractable —
    // the size the archive declares for it is garbage — but that is the input's
    // defect, not something the importer should paper over.)
    expect(new Uint8Array(preserved)).toEqual(bytes)
    expect(Object.keys((await JSZip.loadAsync(preserved)).files)).toContain(PTXPRINT_HELPER_PATH)
  })

  it("still fails, naming the file, when a book has bad size metadata", async () => {
    await expect(filesToProjectEntries([exportWithUnreadableMember(PARATEXT_BOOK_PATH)]))
      .rejects.toThrow(/invalid size metadata: 44ACTSibtatar\.SFM/)
  })

  it("reports nothing skipped for a clean ZIP with no PTXprint folder", async () => {
    const zip = new JSZip()
    zip.file("Settings.xml", "<ScriptureText/>")
    zip.file("01GEN.SFM", "\\id GEN\n\\c 1\n\\v 1 Text")
    const bytes = await zip.generateAsync({ type: "arraybuffer" })

    const entries = await filesToProjectEntries([new File([bytes], "clean.zip")])

    expect(entries.skippedEntries).toBeUndefined()
    expect(entries).toHaveLength(2)
  })
})

describe("filesToProjectEntries Paratext preservation", () => {
  it("retains the exact uploaded ZIP as one package artifact", async () => {
    const zip = new JSZip()
    zip.file("Settings.xml", "<ScriptureText/>")
    zip.file("01GEN.SFM", "\\id GEN\n\\c 1\n\\v 1 Text")
    zip.file("support/license.txt", "license")
    const original = await zip.generateAsync({ type: "arraybuffer" })
    const entries = await filesToProjectEntries([new File([original], "project.zip")])

    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "Settings.xml",
      "01GEN.SFM",
      "support/license.txt",
    ]))
    expect(entries.sourceArtifact?.name).toBe("project.zip")
    expect(await entries.sourceArtifact!.bytes()).toEqual(original)
  })

  it("packages every selected folder member, including non-text support files", async () => {
    const settings = new File(["<ScriptureText/>"], "Settings.xml")
    const book = new File(["\\id GEN\n\\c 1\n\\v 1 Text"], "01GEN.SFM")
    const audio = new File([new Uint8Array([1, 2, 3])], "clip.mp3")
    Object.defineProperty(settings, "webkitRelativePath", { value: "Demo/Settings.xml" })
    Object.defineProperty(book, "webkitRelativePath", { value: "Demo/01GEN.SFM" })
    Object.defineProperty(audio, "webkitRelativePath", { value: "Demo/audio/clip.mp3" })

    const entries = await filesToProjectEntries([settings, book, audio])
    const packed = await JSZip.loadAsync(await entries.sourceArtifact!.bytes())
    expect(entries.sourceArtifact?.name).toBe("Demo.zip")
    expect(Object.keys(packed.files)).toEqual(expect.arrayContaining([
      "Demo/Settings.xml",
      "Demo/01GEN.SFM",
      "Demo/audio/clip.mp3",
    ]))
    expect(await packed.file("Demo/audio/clip.mp3")!.async("uint8array"))
      .toEqual(new Uint8Array([1, 2, 3]))
  })

  it("produces identical package bytes regardless of picker order or retry time", async () => {
    const settings = new File(["<ScriptureText/>"], "Settings.xml")
    const book = new File(["\\id GEN\n\\c 1\n\\v 1 Text"], "01GEN.SFM")
    Object.defineProperty(settings, "webkitRelativePath", { value: "Demo/Settings.xml" })
    Object.defineProperty(book, "webkitRelativePath", { value: "Demo/01GEN.SFM" })

    const forward = await filesToProjectEntries([settings, book])
    const reversed = await filesToProjectEntries([book, settings])

    expect(new Uint8Array(await forward.sourceArtifact!.bytes()))
      .toEqual(new Uint8Array(await reversed.sourceArtifact!.bytes()))
  })
})
