// AQU-1393: the Examples panel marks matches from an imported TMX as
// `TM · <file>`. The check was `file.type === "tmx"`, but the importer stores a
// TMX under the domain kind `translation-memory` and the server sends that kind
// back as the file's type — so a TMX imported through the app was never
// recognised. Pin the importer's own output against the predicate that reads it.

import { describe, expect, it } from "vitest"
import { importedFileKind } from "./import"
import { isTranslationMemoryFile } from "./parsers/types"

describe("isTranslationMemoryFile (AQU-1393)", () => {
  it("recognises the kind the importer stores a TMX under", () => {
    expect(importedFileKind("tmx")).toBe("translation-memory")
    expect(isTranslationMemoryFile(importedFileKind("tmx"))).toBe(true)
  })

  it("still recognises a file whose kind is the parser id", () => {
    expect(isTranslationMemoryFile("tmx")).toBe(true)
  })

  it("does not flag ordinary project files", () => {
    for (const type of ["md", "usfm", "docx", "xliff", "codex", "source"] as const) {
      expect(isTranslationMemoryFile(importedFileKind(type))).toBe(false)
    }
  })
})
