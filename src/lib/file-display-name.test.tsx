// AQU-1937: an extension's display label for a file ("Titus · ULT") shows
// wherever the file's name shows, while the stored name and ids stay as
// imported (so the Door43 extension keeps byte parity with the built-in).

import { describe, expect, it, vi } from "vitest"
import { render, within } from "@testing-library/react"
import { FileRow } from "@/components/FileRow"
import { fileNameFor } from "@/components/TabStrip"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { FileReference } from "@/lib/parsers/types"
import type { DcsCatalogEntry } from "@/lib/dcs/types"
import { door43FileLabel, specForTwCategory } from "@/lib/dcs/extension/door43-plan"
import { fileDisplayName } from "./file-display-name"
import { parseFileExtension, readFileExtension } from "../../shared/tools/file-extension"

const file = (o: Partial<FileReference> = {}): FileReference => ({ id: "f1", name: "TIT (57-TIT.usfm)", type: "usfm", createdAt: "2026-01-01T00:00:00.000Z", cellCount: 48, ...o })

describe("fileDisplayName", () => {
  it("shows the label when there is one, the stored name otherwise", () => {
    expect(fileDisplayName(file({ displayLabel: "Titus · ULT" }))).toBe("Titus · ULT")
    expect(fileDisplayName(file())).toBe("TIT (57-TIT.usfm)")
    expect(fileDisplayName({ name: "x", extension: { label: "From meta" } })).toBe("From meta")
  })

  it("is validated where it is stored (files.meta.extension.label)", () => {
    expect(parseFileExtension({ kind: "normal", tags: [], label: "  Titus · ULT  " })).toMatchObject({ ok: true, value: { label: "Titus · ULT" } })
    expect(parseFileExtension({ kind: "normal", tags: [], label: "x".repeat(121) }).ok).toBe(false)
    expect(parseFileExtension({ kind: "normal", tags: [], label: "bad\nlabel" }).ok).toBe(false)
    expect(readFileExtension({ extension: { kind: "normal", tags: [], label: "Titus · UST" } })?.label).toBe("Titus · UST")
  })
})

describe("surfaces that show a file name", () => {
  it("the sidebar row shows the label; hover keeps the stored name; rename edits the stored name", () => {
    const props = { active: false, expanded: false, onEditCommit: vi.fn(), onEditCancel: vi.fn(), onToggleExpand: vi.fn(), onSelect: vi.fn(), onStartRename: vi.fn(), onMove: vi.fn() }
    const { container, unmount } = render(
      <I18nProvider>
        <FileRow file={file({ displayLabel: "Titus · ULT" })} editing={false} {...props} />
      </I18nProvider>,
    )
    expect(within(container).getByRole("button", { name: "Titus · ULT" })).toBeTruthy()
    expect(container.querySelector('[data-showcase="sidebar.file"]')?.getAttribute("data-showcase-name")).toBe("Titus · ULT")
    unmount()
    const editing = render(
      <I18nProvider>
        <FileRow file={file({ displayLabel: "Titus · ULT" })} editing {...props} />
      </I18nProvider>,
    )
    expect((editing.container.querySelector("input") as HTMLInputElement).value).toBe("TIT (57-TIT.usfm)")
  })

  it("the tab strip shows the label", () => {
    expect(fileNameFor([{ id: "f1", name: "TIT (57-TIT.usfm)", displayLabel: "Titus · Greek (UGNT)" }], "f1")).toBe("Titus · Greek (UGNT)")
    expect(fileNameFor([{ id: "f1", name: "TIT (57-TIT.usfm)" }], "f1")).toBe("TIT (57-TIT.usfm)")
  })
})

describe("Door43 importer labels", () => {
  const entry = (name: string, subject: string, abbreviation: string): DcsCatalogEntry => ({
    name, owner: "unfoldingWord", fullName: `unfoldingWord/${name}`, subject, abbreviation, contentFormat: "", ref: "v1", commitSha: "s", released: "", zipballUrl: "", metadataUrl: "", language: "en",
  })
  it("names the book (manifest title, else canonical) and the resource", () => {
    expect(door43FileLabel(entry("en_ult", "Aligned Bible", "ult"), "TIT", "Titus")).toBe("Titus · ULT")
    expect(door43FileLabel(entry("en_ust", "Aligned Bible", "ust"), "TIT")).toBe("Titus · UST")
    expect(door43FileLabel(entry("el-x-koine_ugnt", "Greek New Testament", "ugnt"), "TIT")).toBe("Titus · Greek (UGNT)")
    expect(door43FileLabel(entry("en_tn", "TSV Translation Notes", "tn"), "TIT")).toBe("Titus · Notes")
    expect(door43FileLabel(entry("en_tq", "TSV Translation Questions", "tq"), "TIT")).toBe("Titus · Questions")
    expect(door43FileLabel(entry("en_twl", "TSV Translation Words Links", "twl"), "TIT")).toBe("Titus · Word links")
    expect(door43FileLabel(entry("en_ult", "Aligned Bible", "ult"), undefined)).toBeUndefined()
  })
  it("labels Translation Words by category, keeping the stored name", () => {
    const spec = specForTwCategory(entry("en_tw", "Translation Words", "tw"), "p1", "kt", [{ word: "god", blocks: [{ kind: "p", level: 0, text: "God.", section: "definition" }] }])!
    expect(spec.label).toBe("Translation Words · Key terms")
    expect(spec.name).toBe("Translation Words: kt")
  })
})
