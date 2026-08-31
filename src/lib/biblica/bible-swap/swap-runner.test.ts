/**
 * The swap runner is the boundary between Aquilla's export flow and the ported
 * codex engine: it opens the exported Study IDML zip, picks the Bible's largest
 * story, swaps every `Stories/*.xml`, and repacks. The contracts worth pinning
 * are that swapped XML actually lands back in the zip, that the report totals
 * come from the engine's own stats, and — because Aquilla replaced codex's
 * `worker_threads` pool with a single Web Worker — that routing stories through
 * the worker protocol yields byte-identical XML to running inline.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { applyBibleSwapToIdml } from "./swap-runner"
import { createBibleSwapRunner } from "./swap-worker-client"
import { handleBibleSwapRequest } from "./swap-worker-handler"
import type { BibleSwapWorkerRequest } from "./swap-worker-protocol"

const NO_STYLE = "CharacterStyle/$ID/[No character style]"

function verse(chapter: string, verseNo: string, text: string): string {
  const chapterMarker =
    verseNo === "1"
      ? `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3ac"><Content>${chapter}:</Content></CharacterStyleRange>`
      : ""
  return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  ${chapterMarker}
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/cv%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${text}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
</ParagraphStyleRange>`
}

function story(book: string, body: string): string {
  return `<?xml version="1.0"?><Story>
<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/meta%3abk">
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${book}</Content></CharacterStyleRange>
</ParagraphStyleRange>${body}</Story>`
}

const STUDY_STORY = story(
  "JOS",
  verse("1", "1", "English Joshua one one.") + verse("1", "2", "English Joshua one two."),
)
const BIBLE_STORY = story(
  "JOS",
  verse("1", "1", "Translated Joshua one one.") +
    verse("1", "2", "Translated Joshua one two."),
)

async function idmlWith(stories: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
  for (const [name, xml] of Object.entries(stories)) zip.file(name, xml)
  return zip.generateAsync({ type: "uint8array" })
}

async function storiesOf(idml: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(idml)
  const out: Record<string, string> = {}
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith("Stories/") || !name.endsWith(".xml")) continue
    out[name] = await zip.file(name)!.async("text")
  }
  return out
}

describe("applyBibleSwapToIdml", () => {
  it("writes swapped verse text back into the study zip and reports the totals", async () => {
    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })
    const bibleIdml = await idmlWith({ "Stories/Story_b1.xml": BIBLE_STORY })

    const { idml, report } = await applyBibleSwapToIdml(studyIdml, bibleIdml)

    const swapped = (await storiesOf(idml))["Stories/Story_u1.xml"]
    expect(swapped).toContain("Translated Joshua one one.")
    expect(swapped).toContain("Translated Joshua one two.")
    expect(swapped).not.toContain("English Joshua one one.")
    expect(report.replacedVerses).toBe(2)
    expect(report.modifiedStories).toBe(1)
  })

  it("preserves non-story entries so the package stays a valid IDML", async () => {
    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })
    const bibleIdml = await idmlWith({ "Stories/Story_b1.xml": BIBLE_STORY })

    const { idml } = await applyBibleSwapToIdml(studyIdml, bibleIdml)

    const zip = await JSZip.loadAsync(idml)
    expect(await zip.file("mimetype")!.async("text")).toBe(
      "application/vnd.adobe.indesign-idml-package",
    )
  })

  it("selects the Bible's largest story as the verse source", async () => {
    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })
    const bibleIdml = await idmlWith({
      "Stories/Story_small.xml": story("JOS", verse("1", "1", "Decoy.")),
      "Stories/Story_big.xml": BIBLE_STORY,
    })

    const { idml } = await applyBibleSwapToIdml(studyIdml, bibleIdml)

    const swapped = (await storiesOf(idml))["Stories/Story_u1.xml"]
    expect(swapped).toContain("Translated Joshua one one.")
    expect(swapped).not.toContain("Decoy.")
  })

  it("rejects a Bible payload that is not a zip archive", async () => {
    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })

    await expect(
      applyBibleSwapToIdml(studyIdml, new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow(/not a valid IDML\/ZIP archive/)
  })
})

describe("bible swap worker protocol", () => {
  /** Stand-in for the bundled worker: same handler, real postMessage hops. */
  function fakeWorker(): Worker {
    const listeners = new Map<string, Set<EventListener>>()
    const worker = {
      addEventListener: (type: string, fn: EventListener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn)
      },
      postMessage: (request: BibleSwapWorkerRequest) => {
        handleBibleSwapRequest(request, (response) => {
          for (const fn of listeners.get("message") ?? []) {
            fn({ data: response } as unknown as Event)
          }
        })
      },
      terminate: () => listeners.clear(),
    }
    return worker as unknown as Worker
  }

  it("produces the same XML through the worker as the inline path", async () => {
    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })
    const bibleIdml = await idmlWith({ "Stories/Story_b1.xml": BIBLE_STORY })

    const inline = await applyBibleSwapToIdml(studyIdml, bibleIdml)
    const viaWorker = await applyBibleSwapToIdml(studyIdml, bibleIdml, {
      parallelRunner: createBibleSwapRunner({ createWorker: fakeWorker }),
    })

    expect(await storiesOf(viaWorker.idml)).toEqual(await storiesOf(inline.idml))
    expect(viaWorker.report).toEqual(inline.report)
  })

  it("reports progress for every story it swaps", async () => {
    const studyIdml = await idmlWith({
      "Stories/Story_u1.xml": STUDY_STORY,
      "Stories/Story_u2.xml": STUDY_STORY,
    })
    const bibleIdml = await idmlWith({ "Stories/Story_b1.xml": BIBLE_STORY })
    const seen: number[] = []

    await applyBibleSwapToIdml(studyIdml, bibleIdml, {
      parallelRunner: createBibleSwapRunner({
        createWorker: fakeWorker,
        onProgress: (p) => seen.push(p.completed),
      }),
    })

    expect(seen).toEqual([1, 2])
  })

  it("surfaces a worker-side failure to the caller", async () => {
    const brokenWorker = () => {
      let onMessage: EventListener | undefined
      return {
        addEventListener: (type: string, fn: EventListener) => {
          if (type === "message") onMessage = fn
        },
        removeEventListener: () => {},
        postMessage: (request: BibleSwapWorkerRequest) => {
          onMessage?.({
            data: { type: "error", id: request.id, message: "boom" },
          } as unknown as Event)
        },
        terminate: () => {},
      } as unknown as Worker
    }

    const studyIdml = await idmlWith({ "Stories/Story_u1.xml": STUDY_STORY })
    const bibleIdml = await idmlWith({ "Stories/Story_b1.xml": BIBLE_STORY })

    await expect(
      applyBibleSwapToIdml(studyIdml, bibleIdml, {
        parallelRunner: createBibleSwapRunner({ createWorker: brokenWorker }),
      }),
    ).rejects.toThrow()
  })
})
