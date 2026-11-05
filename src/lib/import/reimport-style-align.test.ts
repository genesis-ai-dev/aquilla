import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { alignReimportedIdmlFile } = vi.hoisted(() => ({
  alignReimportedIdmlFile: vi.fn(async () => ({
    aligned: [],
    unchanged: 0,
    failed: 0,
    skipped: 0,
    manual: [],
  })),
}))

vi.mock("@/lib/idml/align-reimported-targets", () => ({
  alignReimportedIdmlFile,
}))

import { emitParsedFile } from "@/lib/import"
import type { IdmlReimportAlignHost } from "@/lib/idml/align-reimported-targets"

const host: IdmlReimportAlignHost = {
  ask: async () => "",
  author: "dev",
  model: "frontier-default",
  provider: "frontier",
  flush: async () => {},
}

const note = {
  id: "cell-1",
  original: "Hello",
  translated: "Bonjour",
  context: "",
  group: "g",
  type: "text" as const,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  alignReimportedIdmlFile.mockClear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
  )
})

describe("re-import style alignment", () => {
  it("places kept translations into style runs on an updated copy", async () => {
    const emitted = await emitParsedFile(
      { name: "Notes.idml", strings: [note] },
      "idml",
      {
        projectId: "project",
        author: "dev",
        getToken: async () => "token",
        targetLang: "fr",
        sidebarReimport: {
          mode: "updated-copy",
          targetFileId: "original-file",
          existingNames: ["Notes.idml"],
          suffix: "updated",
        },
        alignReimportedIdml: host,
      },
    )

    expect(alignReimportedIdmlFile).toHaveBeenCalledOnce()
    expect(alignReimportedIdmlFile).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project",
      fileId: emitted.ref.id,
      lane: "fr",
      host,
    }))
    expect(emitted.ref.id).not.toBe("original-file")
  })

  it("places kept translations when the same file is updated in place", async () => {
    await emitParsedFile(
      { name: "Notes.idml", strings: [note] },
      "idml",
      {
        projectId: "project",
        author: "dev",
        getToken: async () => "token",
        sidebarReimport: {
          mode: "update",
          targetFileId: "original-file",
          existingNames: [],
          suffix: "updated",
        },
        alignReimportedIdml: host,
      },
    )

    expect(alignReimportedIdmlFile).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "original-file",
    }))
  })

  it("does not place styles on a blank copy or a file without style runs", async () => {
    await emitParsedFile(
      { name: "Notes.idml", strings: [note] },
      "idml",
      {
        projectId: "project",
        author: "dev",
        getToken: async () => "token",
        sidebarReimport: {
          mode: "blank",
          targetFileId: "original-file",
          existingNames: ["Notes.idml"],
          suffix: "blank",
        },
        alignReimportedIdml: host,
      },
    )
    await emitParsedFile(
      { name: "Jonah.usfm", strings: [note] },
      "usfm",
      {
        projectId: "project",
        author: "dev",
        getToken: async () => "token",
        sidebarReimport: {
          mode: "updated-copy",
          targetFileId: "original-file",
          existingNames: ["Jonah.usfm"],
          suffix: "updated",
        },
        alignReimportedIdml: host,
      },
    )

    expect(alignReimportedIdmlFile).not.toHaveBeenCalled()
  })
})
