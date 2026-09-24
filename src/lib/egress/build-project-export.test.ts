// buildProjectExport is the per-project half of the egress transparency
// contract: every selected file must either produce entries or a skip/note the
// user can act on. These tests pin the routing table (native vs convert), the
// fixed skip copy the UI/manifest surface, lane foldering, sidecar-fetch
// economy, and path dedupe — all with injected fakes (no network).

import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { AudioAssemblyArgs, AudioAssemblyResult } from "@/lib/export/audio-assembly"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"
import { SourceExportError } from "@/lib/sync/source-export"
import {
  buildProjectExport,
  egressSlug,
  type BuildProjectExportDeps,
} from "./build-project-export"
import type { EgressFileRef, EgressOptions, EgressProjectSelection } from "./types"

const cell = (over: Partial<CellData> = {}): CellData => ({
  id: "c1", fileId: "f1", original: "Hello", translated: "Bonjour", context: "", group: "",
  type: "verse", status: "unvalidated", validationStatus: "none",
  activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
})

const sel = (files: EgressFileRef[]): EgressProjectSelection => ({
  projectId: "p1",
  projectName: "Project One",
  sourceLanguage: "en",
  targetLanguage: "swh",
  files,
})

const opts = (over: Partial<EgressOptions> = {}): EgressOptions => ({
  textMode: "original",
  convertFormat: "txt",
  lanes: ["fr"],
  includeSourceDocs: false,
  audioMode: "none",
  useCache: true,
  ...over,
})

/** Listing with one selected recording clip on cell `cellId`. */
const listingWith = (cellId: string, audioId: string): FileAudioAttachmentsResponse => ({
  cells: {
    [cellId]: {
      attachments: {
        [audioId]: {
          audioId,
          url: `frontier-audio://${audioId}.wav`,
          slot: "recording",
          mimeType: "audio/wav",
          voiceId: null,
          referenceAudioId: null,
          durationMs: 1200,
          trimStartMs: null,
          trimEndMs: null,
        },
      },
      selectedAudioId: audioId,
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
    },
  },
})

const makeDeps = (over: Partial<BuildProjectExportDeps> = {}): BuildProjectExportDeps => ({
  jwt: "jwt",
  getToken: async () => "tok",
  freshnessKey: "fresh-1",
  loadCellFiles: async ({ projectFiles }) =>
    projectFiles.map((f) => ({ fileId: f.id, fileName: f.name, cells: [cell({ fileId: f.id })] })),
  fetchAudioAttachments: async () => ({ cells: {} }),
  fetchSidecar: async () => new TextEncoder().encode("RAW").buffer as ArrayBuffer,
  fetchRawSource: async () => ({
    bytes: new TextEncoder().encode("RAW-ORIGINAL").buffer as ArrayBuffer,
    rawOriginal: true,
  }),
  fetchInjectedText: async ({ fileId, targetLang }) => `\\id ${fileId} lane=${targetLang ?? "default"}`,
  assembleAudio: async () => ({ entries: [], skipped: [] }),
  exportDocxFn: async () => ({ blob: new Blob(["DOCX-INJECTED"]) }),
  exportPptxFn: async () => ({ blob: new Blob(["PPTX-INJECTED"]) }),
  exportIdmlFn: async () => ({ blob: new Blob(["IDML-INJECTED"]) }),
  ...over,
})

describe("buildProjectExport — text routing", () => {
  it("original mode routes usfm→injected text, docx→sidecar injection, unmapped→convert fallback with a note", async () => {
    const { entries, report } = await buildProjectExport(
      sel([
        { id: "f1", name: "GEN.SFM", type: "usfm" },
        { id: "f2", name: "Slides.docx", type: "docx" },
        { id: "f3", name: "Story", type: "ebible" },
      ]),
      opts(),
      makeDeps(),
    )

    const paths = entries.map((e) => e.path)
    expect(paths).toEqual(["fr/GEN.usfm", "fr/Slides.docx", "fr/Story.txt"])
    // usfm carries the server-injected text for the requested lane.
    expect(entries[0].data).toBe("\\id f1 lane=fr")
    expect(await (entries[1].data as Blob).text()).toBe("DOCX-INJECTED")
    // Fallback is not a skip — the file WAS exported — but the manifest must
    // say the format differs from what "original" promised.
    const story = report.files.find((f) => f.fileId === "f3")!
    expect(story.entries).toEqual(["fr/Story.txt"])
    expect(story.skipped).toEqual([])
    expect(story.notes).toEqual([
      'no native round-trip exporter for type "ebible" — converted to txt',
    ])
    expect(report.freshnessKey).toBe("fresh-1")
    expect(report.fromCache).toBe(false)
  })

  it("convert mode re-serializes everything via exportFileCells (no round-trip fetches)", async () => {
    const fetchInjectedText = vi.fn()
    const { entries, report } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ textMode: "convert", convertFormat: "txt" }),
      makeDeps({ fetchInjectedText }),
    )
    expect(entries.map((e) => e.path)).toEqual(["fr/GEN.txt"])
    // Real exportFileCells output: the fixture cell's translation.
    expect(await (entries[0].data as Blob).text()).toBe("Bonjour\n")
    expect(fetchInjectedText).not.toHaveBeenCalled()
    expect(report.files[0].entries).toEqual(["fr/GEN.txt"])
  })

  it("default lane ('') folders under the project targetLanguage and requests the legacy lane", async () => {
    const fetchInjectedText = vi.fn<
      NonNullable<BuildProjectExportDeps["fetchInjectedText"]>
    >(async () => "usfm-text")
    const { entries } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ lanes: [""] }),
      makeDeps({ fetchInjectedText }),
    )
    expect(entries[0].path).toBe("swh/GEN.usfm")
    // "" must reach the server as NO lane param (legacy default lane), not "".
    expect(fetchInjectedText.mock.calls[0]![0].targetLang).toBeUndefined()
  })

  it("a 404 sidecar becomes the fixed re-import skip copy, never a crash", async () => {
    const { entries, report } = await buildProjectExport(
      sel([
        { id: "f1", name: "Slides.docx", type: "docx" },
        { id: "f2", name: "GEN.SFM", type: "usfm" },
      ]),
      opts(),
      makeDeps({
        fetchSidecar: async () => {
          throw new SourceExportError("not found", 404)
        },
      }),
    )
    // The docx is skipped with actionable copy; the usfm still exports.
    expect(entries.map((e) => e.path)).toEqual(["fr/GEN.usfm"])
    const docx = report.files.find((f) => f.fileId === "f1")!
    expect(docx.entries).toEqual([])
    expect(docx.skipped).toEqual([
      {
        scope: "Slides.docx (fr)",
        reason: "no sidecar stored (imported before round-trip support); re-import to enable",
      },
    ])
  })

  it("a 403 surfaces the org-policy copy per file", async () => {
    const { report } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts(),
      makeDeps({
        fetchInjectedText: async () => {
          throw new SourceExportError("forbidden", 403)
        },
      }),
    )
    expect(report.files[0].skipped[0].reason).toBe("export blocked by org policy (HTTP 403)")
  })
})

describe("buildProjectExport — source docs, audio, dedupe", () => {
  it("fetches the source document ONCE per file across lanes, with no lane param", async () => {
    // USFM source docs go through the raw-mode fetch (AQU-907).
    const fetchRawSource = vi.fn<NonNullable<BuildProjectExportDeps["fetchRawSource"]>>(
      async () => ({
        bytes: new TextEncoder().encode("RAW-ORIGINAL").buffer as ArrayBuffer,
        rawOriginal: true,
      }),
    )
    const { entries, report } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ lanes: ["fr", "de"], includeSourceDocs: true }),
      makeDeps({ fetchRawSource }),
    )
    // Two lane copies of the text + one source document — not one per lane.
    expect(entries.map((e) => e.path)).toEqual([
      "fr/GEN.usfm",
      "de/GEN.usfm",
      "source-documents/GEN.SFM",
    ])
    expect(fetchRawSource).toHaveBeenCalledTimes(1)
    expect(fetchRawSource.mock.calls[0]![0].targetLang).toBeUndefined()
    expect(report.files[0].entries).toHaveLength(3)
  })

  it("prefixes audio entries with audio/<lane>/<file-base>/ and collapses all-silent files", async () => {
    const outputs: AudioAssemblyResult[] = [
      {
        entries: [{ name: "000_c1_Mary.wav", data: new Blob(["wav"]) }],
        skipped: [{ cellId: "c2", reason: "empty audio clip" }],
      },
      {
        entries: [],
        skipped: [
          { cellId: "c1", reason: "no audio" },
          { cellId: "c2", reason: "no audio" },
        ],
      },
    ]
    let call = 0
    const assembleAudio = vi.fn(async (_args: AudioAssemblyArgs) => outputs[call++])
    const { entries, report } = await buildProjectExport(
      sel([
        { id: "f1", name: "GEN.SFM", type: "usfm" },
        { id: "f2", name: "Notes.txt", type: "txt" },
      ]),
      opts({ textMode: "none", audioMode: "separate-clips" }),
      makeDeps({ assembleAudio }),
    )
    expect(entries.map((e) => e.path)).toEqual(["audio/fr/GEN/000_c1_Mary.wav"])
    // Real failures stay per-clip so they're actionable…
    expect(report.files[0].skipped).toEqual([
      { scope: "cell c2 (audio, fr)", reason: "empty audio clip" },
    ])
    // …but a file with no audio at all collapses to one line instead of
    // spamming the manifest with a row per text-only cell.
    expect(report.files[1].skipped).toEqual([
      { scope: "Notes.txt (audio, fr)", reason: "no audio on this file" },
    ])
    expect(assembleAudio.mock.calls[0][0]).toMatchObject({ mode: "separate-clips", fileSlug: "GEN" })
  })

  it("dedupes colliding entry paths with _2 suffixes instead of overwriting", async () => {
    const { entries } = await buildProjectExport(
      sel([
        { id: "f1", name: "a b.txt", type: "txt" },
        { id: "f2", name: "a-b.txt", type: "txt" },
      ]),
      opts(),
      makeDeps(),
    )
    // Both names slug to "a-b" — a silent overwrite would lose f2's content.
    expect(entries.map((e) => e.path)).toEqual(["fr/a-b.txt", "fr/a-b_2.txt"])
  })

  it("REGRESSION: audio modes merge the attachments listing into bare cells — the real assembler must produce entries", async () => {
    // loadProjectCellFiles cells NEVER carry attachments/selected slots
    // (buildCellData doesn't populate them). Pre-fix, the engine fed them to
    // the assembler as-is → every cell skipped "no audio" → silent zero-audio
    // zips. assembleAudio is NOT injected here: the default (the real
    // assembleAudioEntries) must see the merged listing and emit the clip.
    const fetchAudioBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const { entries, report } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ textMode: "none", audioMode: "separate-clips" }),
      makeDeps({
        assembleAudio: undefined, // real assembler — the fake would mask the merge
        fetchAudioAttachments: async () => listingWith("c1", "a1"),
        fetchAudioBytes,
        decodeAudio: async () => new Float32Array(48),
      }),
    )
    // Untrimmed unique clip passes through as stored bytes under the cast
    // voice's name (no settings → preset "Narrator").
    expect(entries.map((e) => e.path)).toEqual(["audio/fr/GEN/000_c1_Narrator.wav"])
    expect(new Uint8Array(await (entries[0].data as Blob).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(report.files[0].skipped).toEqual([])
    expect(fetchAudioBytes).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1", audioId: "a1", ext: "wav" }),
    )
  })

  it("uses orchestrator-prefetched audioListings without refetching, once per file across lanes", async () => {
    const fetchAudioAttachments = vi.fn<
      NonNullable<BuildProjectExportDeps["fetchAudioAttachments"]>
    >(async () => ({ cells: {} }))
    const assembleAudio = vi.fn(async (args: AudioAssemblyArgs): Promise<AudioAssemblyResult> => {
      // The merged listing must reach the assembler through the cells.
      expect(args.cells[0].selectedAudioId).toBe("a1")
      return { entries: [], skipped: [] }
    })
    await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ textMode: "none", audioMode: "separate-clips", lanes: ["fr", "de"] }),
      makeDeps({
        audioListings: new Map([["f1", listingWith("c1", "a1")]]),
        fetchAudioAttachments,
        assembleAudio,
      }),
    )
    expect(fetchAudioAttachments).not.toHaveBeenCalled()
    expect(assembleAudio).toHaveBeenCalledTimes(2) // one per lane, same listing
  })

  it("a failed attachments-listing fetch is a per-file transient skip, not a project abort", async () => {
    const { entries, report, hadTransientFailures } = await buildProjectExport(
      sel([
        { id: "f1", name: "GEN.SFM", type: "usfm" },
        { id: "f2", name: "EXO.SFM", type: "usfm" },
      ]),
      opts({ textMode: "none", audioMode: "separate-clips" }),
      makeDeps({
        fetchAudioAttachments: async (_p, fileId) => {
          if (fileId === "f1") throw new Error("audio-attachments failed: HTTP 500")
          return { cells: {} }
        },
        assembleAudio: async () => ({ entries: [], skipped: [] }),
      }),
    )
    expect(entries).toEqual([])
    expect(report.files[0].skipped).toEqual([
      { scope: "GEN.SFM (audio, fr)", reason: "audio-attachments failed: HTTP 500" },
    ])
    // f2 still ran — one flaky file must not sink the project.
    expect(report.files[1].skipped).toEqual([])
    // …but the hole is retryable, so the result must not be cacheable.
    expect(hadTransientFailures).toBe(true)
  })
})

describe("buildProjectExport — transient-failure classification (cache poisoning guard)", () => {
  it("404/403 SourceExportErrors are stable states — cacheable", async () => {
    const { hadTransientFailures } = await buildProjectExport(
      sel([
        { id: "f1", name: "Slides.docx", type: "docx" },
        { id: "f2", name: "Deck.pptx", type: "pptx" },
      ]),
      opts(),
      makeDeps({
        fetchSidecar: async ({ fileId }) => {
          throw fileId === "f1"
            ? new SourceExportError("not found", 404)
            : new SourceExportError("forbidden", 403)
        },
      }),
    )
    expect(hadTransientFailures).toBe(false)
  })

  it("network/5xx text failures are transient — the zip must not be cached with the hole", async () => {
    const { hadTransientFailures } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts(),
      makeDeps({
        fetchInjectedText: async () => {
          throw new Error("fetch failed")
        },
      }),
    )
    expect(hadTransientFailures).toBe(true)
  })

  it("per-clip 'audio failed:' skips from the assembler are transient; 'no audio' is not", async () => {
    const outcomes: AudioAssemblyResult[] = [
      { entries: [], skipped: [{ cellId: "c1", reason: "no audio" }] },
      { entries: [], skipped: [{ cellId: "c1", reason: "audio failed: HTTP 502" }] },
    ]
    for (const [i, outcome] of outcomes.entries()) {
      const { hadTransientFailures } = await buildProjectExport(
        sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
        opts({ textMode: "none", audioMode: "separate-clips" }),
        makeDeps({ assembleAudio: async () => outcome }),
      )
      expect(hadTransientFailures).toBe(i === 1)
    }
  })
})

describe("buildProjectExport — source-doc honesty & slug safety", () => {
  it("fetches USFM source documents via raw mode — no honesty note when the server honors it", async () => {
    const fetchRawSource = vi.fn<NonNullable<BuildProjectExportDeps["fetchRawSource"]>>(
      async () => ({
        bytes: new TextEncoder().encode("RAW-ORIGINAL").buffer as ArrayBuffer,
        rawOriginal: true,
      }),
    )
    const fetchSidecar = vi.fn<NonNullable<BuildProjectExportDeps["fetchSidecar"]>>(
      async () => new TextEncoder().encode("RAW").buffer as ArrayBuffer,
    )
    const { report } = await buildProjectExport(
      sel([
        { id: "f1", name: "GEN.SFM", type: "usfm" },
        { id: "f2", name: "Slides.docx", type: "docx" },
      ]),
      opts({ textMode: "none", includeSourceDocs: true }),
      makeDeps({ fetchRawSource, fetchSidecar }),
    )
    // AQU-907: USFM goes through ?mode=raw (byte-exact original — no note);
    // docx sidecars are already the stored bytes via the plain fetch.
    expect(fetchRawSource).toHaveBeenCalledTimes(1)
    expect(fetchSidecar).toHaveBeenCalledTimes(1)
    expect(report.files[0].entries).toEqual(["source-documents/GEN.SFM"])
    expect(report.files[0].notes).toBeUndefined()
    expect(report.files[1].notes).toBeUndefined()
  })

  it("records the injection-honesty note when the server predates raw mode", async () => {
    // An old sync-worker ignores ?mode=raw and returns the injected
    // serialization (no raw-original header). The manifest must say so
    // instead of presenting the entry as the byte-exact upload.
    const fetchRawSource = vi.fn<NonNullable<BuildProjectExportDeps["fetchRawSource"]>>(
      async () => ({
        bytes: new TextEncoder().encode("INJECTED").buffer as ArrayBuffer,
        rawOriginal: false,
      }),
    )
    const { report } = await buildProjectExport(
      sel([{ id: "f1", name: "GEN.SFM", type: "usfm" }]),
      opts({ textMode: "none", includeSourceDocs: true }),
      makeDeps({ fetchRawSource }),
    )
    expect(report.files[0].entries).toEqual(["source-documents/GEN.SFM"])
    expect(report.files[0].notes?.join(" ")).toMatch(/translations injected/)
  })

  it("egressSlug rejects all-dot names that would escape the zip folder", () => {
    // ".." survives the charset regex — as a path segment it climbs out of
    // the archive folder on naive extractors (zip-slip).
    expect(egressSlug("..", "file")).toBe("file")
    expect(egressSlug(".", "file")).toBe("file")
    expect(egressSlug("...", "project")).toBe("project")
    expect(egressSlug("v1..2 notes", "file")).toBe("v1..2-notes") // interior dots stay
  })
})

describe("buildProjectExport — file×lane fetch concurrency", () => {
  it("runs at most 4 file×lane fetches at once and still emits entries in input order", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`,
      name: `File${i}.SFM`,
      type: "usfm" as const,
    }))
    const lanes = ["fr", "de"]
    const totalUnits = files.length * lanes.length
    let inFlight = 0
    let maxInFlight = 0
    const pendingReleases: Array<() => void> = []
    const completionOrder: string[] = []

    const fetchInjectedText = vi.fn<NonNullable<BuildProjectExportDeps["fetchInjectedText"]>>(
      async ({ fileId, targetLang }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await new Promise<void>((resolve) => {
            pendingReleases.push(resolve)
          })
        } finally {
          inFlight -= 1
        }
        completionOrder.push(`${targetLang}:${fileId}`)
        return `\\id ${fileId} lane=${targetLang}`
      },
    )

    const pending = buildProjectExport(
      sel(files),
      opts({ lanes }),
      makeDeps({ fetchInjectedText }),
    )

    let finished = 0
    while (finished < totalUnits) {
      await vi.waitFor(() => expect(pendingReleases).toHaveLength(4))
      await new Promise((r) => setTimeout(r, 0))
      expect(pendingReleases).toHaveLength(4)
      expect(inFlight).toBe(4)
      const wave = pendingReleases.splice(0, 4)
      finished += wave.length
      // Finish the wave last-started-first so completion order diverges from
      // lane/file order. Archive entries must stay in input order anyway.
      while (wave.length > 0) wave.pop()!()
    }

    expect(maxInFlight).toBe(4)
    expect(completionOrder).not.toEqual(
      lanes.flatMap((lane) => files.map((file) => `${lane}:${file.id}`)),
    )

    const { entries, report } = await pending
    expect(entries.map((e) => e.path)).toEqual([
      ...files.map((file) => `fr/${file.name.replace(/\.SFM$/, "")}.usfm`),
      ...files.map((file) => `de/${file.name.replace(/\.SFM$/, "")}.usfm`),
    ])
    expect(entries.map((e) => e.data)).toEqual([
      ...files.map((file) => `\\id ${file.id} lane=fr`),
      ...files.map((file) => `\\id ${file.id} lane=de`),
    ])
    expect(report.files[0].entries).toEqual(["fr/File0.usfm", "de/File0.usfm"])
    expect(fetchInjectedText).toHaveBeenCalledTimes(totalUnits)
  })

  it("assigns deduped paths from input order when a later file finishes first", async () => {
    const releases = new Map<string, () => void>()
    const loadCellFiles = vi.fn<NonNullable<BuildProjectExportDeps["loadCellFiles"]>>(
      async ({ projectFiles, lane }) => {
        const file = projectFiles[0]!
        await new Promise<void>((resolve) => {
          releases.set(`${lane}:${file.id}`, resolve)
        })
        return [
          {
            fileId: file.id,
            fileName: file.name,
            cells: [cell({ fileId: file.id, translated: `${lane}:${file.id}` })],
          },
        ]
      },
    )

    const pending = buildProjectExport(
      sel([
        { id: "slow", name: "a b.txt", type: "txt" },
        { id: "fast", name: "a-b.txt", type: "txt" },
      ]),
      opts({ lanes: ["fr", "de"], textMode: "convert", convertFormat: "txt" }),
      makeDeps({ loadCellFiles }),
    )

    await vi.waitFor(() => expect(releases.size).toBe(4))
    for (const key of ["fr:fast", "de:fast", "fr:slow", "de:slow"]) releases.get(key)!()

    const { entries, report } = await pending
    expect(entries.map((e) => e.path)).toEqual([
      "fr/a-b.txt",
      "fr/a-b_2.txt",
      "de/a-b.txt",
      "de/a-b_2.txt",
    ])
    expect(report.files.map((f) => f.entries)).toEqual([
      ["fr/a-b.txt", "de/a-b.txt"],
      ["fr/a-b_2.txt", "de/a-b_2.txt"],
    ])
    expect(await Promise.all(entries.map((e) => (e.data as Blob).text()))).toEqual([
      "fr:slow\n",
      "fr:fast\n",
      "de:slow\n",
      "de:fast\n",
    ])
  })
})
