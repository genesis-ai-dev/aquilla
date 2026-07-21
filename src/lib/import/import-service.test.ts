import { describe, expect, it, vi } from "vitest"
import type { FileType } from "@/lib/parsers/types"
import { ImportService } from "./import-service"

interface Context {
  skipKeys?: ReadonlySet<string>
}

function service(overrides: Partial<ConstructorParameters<typeof ImportService<Context, string>>[0]> = {}) {
  const dependencies = {
    detectFileType: vi.fn((_name: string): FileType | null => "usfm"),
    isMediaFileType: vi.fn(() => false),
    parseFile: vi.fn(async () => [{
      name: "Genesis",
      bookCode: "GEN",
      strings: [{
        id: "source-cell",
        original: "In the beginning",
        translated: "",
        context: "GEN 1:1",
        group: "GEN 1:1",
        globalReferences: ["GEN 1:1"],
        type: "verse" as const,
      }],
    }]),
    emitMediaFile: vi.fn(async () => "media-ref"),
    emitParsedFile: vi.fn(async (_result, _fileType, _context, manifest) => ({
      ref: manifest.units[0].unitKey,
      speakerPairs: [],
    })),
    ...overrides,
  }
  return { instance: new ImportService<Context, string>(dependencies), dependencies }
}

describe("ImportService", () => {
  it("normalizes a deterministic parser result before committing it", async () => {
    const { instance, dependencies } = service()

    const result = await instance.importFile(new File(["\\id GEN"], "01GEN.SFM"), {})

    expect(result.refs).toEqual(["scripture:GEN 1:1"])
    expect(result.manifests).toHaveLength(1)
    expect(result.manifests[0]).toMatchObject({
      fileType: "usfm",
      profileId: "builtin:usfm-lossless",
      deterministic: true,
      fidelity: "native",
    })
    expect(dependencies.emitParsedFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dependencies.emitParsedFile).mock.calls[0][3].units[0]).toMatchObject({
      unitKey: "scripture:GEN 1:1",
      displayLabel: "1",
    })
  })

  it("preserves USX provenance without claiming a translated USX round trip", async () => {
    const { instance } = service({
      parseFile: vi.fn(async () => [{
        name: "Genesis.usx",
        rawSourceFormat: "usx",
        rawBytes: new ArrayBuffer(8),
        strings: [{
          id: "source-cell",
          original: "In the beginning",
          translated: "",
          context: "GEN 1:1",
          group: "GEN 1:1",
          globalReferences: ["GEN 1:1"],
          type: "verse" as const,
        }],
      }]),
    })

    const result = await instance.importFile(new File(["<usx />"], "Genesis.usx"), {})

    expect(result.manifests[0]).toMatchObject({
      profileId: "builtin:usx-to-usfm",
      deterministic: true,
      fidelity: "content-only",
    })
  })

  it("honours existing whole-file and per-book collision skip decisions", async () => {
    const first = service()
    const skippedFile = await first.instance.importFile(
      new File(["x"], "01GEN.SFM"),
      { skipKeys: new Set(["01gen.sfm"]) },
    )
    expect(skippedFile.refs).toEqual([])
    expect(first.dependencies.parseFile).not.toHaveBeenCalled()

    const second = service()
    const skippedBook = await second.instance.importFile(
      new File(["x"], "bundle.usfm"),
      { skipKeys: new Set(["GEN"]) },
    )
    expect(skippedBook.refs).toEqual([])
    expect(second.dependencies.emitParsedFile).not.toHaveBeenCalled()
  })

  it("keeps opaque media inside the same gateway without invoking a text parser", async () => {
    const { instance, dependencies } = service({
      detectFileType: vi.fn((_name: string): FileType | null => "audio"),
      isMediaFileType: vi.fn(() => true),
    })

    const result = await instance.importFile(new File(["audio"], "clip.mp3"), {})

    expect(result.refs).toEqual(["media-ref"])
    expect(dependencies.emitMediaFile).toHaveBeenCalledTimes(1)
    expect(dependencies.parseFile).not.toHaveBeenCalled()
  })

  it("rejects unknown files before any parser or writer runs", async () => {
    const { instance, dependencies } = service({ detectFileType: vi.fn(() => null) })

    await expect(instance.importFile(new File(["x"], "unknown.bin"), {}))
      .rejects.toThrow("Unsupported file type: unknown.bin")
    expect(dependencies.parseFile).not.toHaveBeenCalled()
    expect(dependencies.emitParsedFile).not.toHaveBeenCalled()
  })

  it("commits a prepared AI recipe without parsing or classifying the file again", async () => {
    const { instance, dependencies } = service({ detectFileType: vi.fn(() => null) })
    const recipe = {
      version: 1 as const,
      id: "ai-recipe-1",
      name: "Line records",
      inputFormat: "unknown-lines",
      strategy: "records" as const,
      config: { recordMode: "line" },
      proposedBy: "ai" as const,
    }

    const result = await instance.importFile(new File(["source"], "unknown.odd"), {}, {
      fileType: "custom",
      results: [{
        name: "unknown.odd",
        strings: [{
          id: "source-cell",
          original: "source",
          translated: "target",
          context: "Line 1",
          group: "line-1",
          type: "text",
          metadata: { aquillaRecipe: { recipeId: recipe.id, record: 1 } },
        }],
        importRecipe: recipe,
      }],
    })

    expect(dependencies.parseFile).not.toHaveBeenCalled()
    expect(result.manifests[0]).toMatchObject({
      fileType: "custom",
      deterministic: false,
      fidelity: "content-only",
      recipe,
    })
    expect(result.manifests[0].units[0]).toMatchObject({
      address: { scheme: "custom", recipeId: "ai-recipe-1", record: 1 },
      targetText: "target",
    })
  })
})
