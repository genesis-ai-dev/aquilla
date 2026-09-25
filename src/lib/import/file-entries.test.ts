import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { filesToProjectEntries } from "./file-entries"

/** A real Paratext-shaped ZIP whose `entryName` member reports unreadable size
 *  metadata once JSZip has loaded it — the AQU-1406 failure, which a hand-built
 *  archive cannot express (a size header is always a valid uint32). */
async function zipWithUnreadableEntry(entryName: string): Promise<File> {
  const zip = new JSZip()
  zip.file("Settings.xml", "<ScriptureText/>")
  zip.file("01GENsibtatar.SFM", "\\id GEN\n\\c 1\n\\v 1 Text")
  zip.file("44ACTSibtatar.SFM", "\\id ACT\n\\c 1\n\\v 1 Text")
  zip.file("shared/ptxprint/Default/FRTlocal.sfm", "\\id FRT\n\\mt PTXprint helper")
  const bytes = await zip.generateAsync({ type: "arraybuffer" })

  const load = JSZip.loadAsync.bind(JSZip)
  vi.spyOn(JSZip, "loadAsync").mockImplementation(async (data, options) => {
    const loaded = await load(data, options)
    const entry = loaded.files[entryName] as unknown as { _data: { uncompressedSize?: number } }
    entry._data.uncompressedSize = undefined
    return loaded
  })
  return new File([bytes], "sibtatar.zip")
}

describe("AQU-1406 — an unreadable support member does not fail a Paratext ZIP", () => {
  afterEach(() => vi.restoreAllMocks())

  it("skips a PTXprint helper with bad size metadata and imports every book", async () => {
    const zip = await zipWithUnreadableEntry("shared/ptxprint/Default/FRTlocal.sfm")

    const entries = await filesToProjectEntries([zip])

    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "Settings.xml",
      "01GENsibtatar.SFM",
      "44ACTSibtatar.SFM",
    ]))
    expect(entries.map((entry) => entry.name))
      .not.toContain("shared/ptxprint/Default/FRTlocal.sfm")
    expect(entries.skippedEntries).toEqual([
      { name: "shared/ptxprint/Default/FRTlocal.sfm", reason: "skipped (not scripture content)" },
    ])
    // The package artifact still holds the original bytes, helper included.
    expect(entries.sourceArtifact?.name).toBe("sibtatar.zip")
  })

  it("still fails, naming the file, when a book has bad size metadata", async () => {
    const zip = await zipWithUnreadableEntry("44ACTSibtatar.SFM")

    await expect(filesToProjectEntries([zip]))
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
