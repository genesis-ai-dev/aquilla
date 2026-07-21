import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { filesToProjectEntries } from "./file-entries"

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
