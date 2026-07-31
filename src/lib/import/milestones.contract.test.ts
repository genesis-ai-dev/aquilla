import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import type { FileType, TranslatableString } from "@/lib/parsers/types"
import { extractJsonStrings } from "@/lib/parsers/json-i18n"
import { extractMarkdownStrings } from "@/lib/parsers/markdown"
import { extractPoStrings } from "@/lib/parsers/po"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import { extractVttStrings } from "@/lib/parsers/subtitle"
import { extractUsfmStrings } from "@/lib/parsers/usfm"
import { parseXliff } from "@/lib/parsers/xliff"
import { buildBulkCells } from "@/lib/import"
import { deriveMilestoneNavigation, readImportMilestone } from "@/lib/milestone-navigation"
import { normalizeTranslatableStrings } from "./normalized-manifest"

function roundTripNavigation(
  strings: TranslatableString[],
  fileName: string,
  fileType: FileType,
) {
  const normalized = normalizeTranslatableStrings(strings, { fileName, fileType })
  const cells = buildBulkCells(strings, { normalizedFile: normalized })
  for (const cell of cells) {
    expect(readImportMilestone(cell.metadata)).toBeDefined()
  }
  return deriveMilestoneNavigation(cells.map((cell) => ({
    id: cell.cellId,
    original: cell.value,
    type: cell.type ?? null,
    canonicalRef: cell.canonicalRef ?? null,
    ...(typeof cell.startMs === "number" ? { startMs: cell.startMs } : {}),
    metadata: cell.metadata ?? null,
  })))
}

async function makePptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const slide = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`
  zip.file("ppt/slides/slide1.xml", slide("Welcome", "Opening"))
  zip.file("ppt/slides/slide2.xml", slide("Next steps", "Closing"))
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("parser → normalization → emission → navigation milestone contract", () => {
  it("preserves Scripture chapter semantics through the complete cell metadata path", () => {
    const [book] = extractUsfmStrings("\\id GEN\n\\c 1\n\\v 1 In the beginning\n\\c 2\n\\v 1 Thus the heavens")
    const navigation = roundTripNavigation(book.strings, "GEN.usfm", "usfm")

    expect(navigation.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual([
      "Genesis 1",
      "Genesis 2",
    ])
  })

  it("preserves Markdown heading sections through the complete cell metadata path", () => {
    const navigation = roundTripNavigation(
      extractMarkdownStrings("Before\n\n# Introduction\nFirst\n\n# Details\nSecond"),
      "guide.md",
      "md",
    )

    expect(navigation.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual([
      "Start",
      "Introduction",
      "Details",
    ])
  })

  it("preserves presentation slide titles through the complete cell metadata path", async () => {
    const navigation = roundTripNavigation(
      await extractPptxStrings(await makePptx()),
      "deck.pptx",
      "pptx",
    )

    expect(navigation.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual([
      "Slide 1: Welcome",
      "Slide 2: Next steps",
    ])
  })

  it("preserves subtitle time buckets through the complete cell metadata path", () => {
    const navigation = roundTripNavigation(extractVttStrings(`WEBVTT

00:00:01.000 --> 00:00:02.000
Opening

00:05:01.000 --> 00:05:03.000
Later
`), "episode.vtt", "vtt")

    expect(navigation.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual([
      "00:00–05:00",
      "05:00–10:00",
    ])
  })

  it("preserves JSON top-level paths and localization-native groups", () => {
    const json = roundTripNavigation(
      extractJsonStrings('{"menu":{"open":"Open"},"dialog":{"close":"Close"}}'),
      "messages.json",
      "json",
    )
    expect(json.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual(["menu", "dialog"])

    const po = roundTripNavigation(extractPoStrings([
      'msgctxt "menu"',
      'msgid "Open"',
      'msgstr ""',
      "",
      '#: src/dialog.ts:12',
      'msgid "Close"',
      'msgstr ""',
    ].join("\n")), "messages.po", "po")
    expect(po.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual(["menu", "src/dialog.ts"])

    const xliff = roundTripNavigation(parseXliff(`<?xml version="1.0"?>
<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0">
  <file id="app">
    <group id="menu"><unit id="open"><segment><source>Open</source></segment></unit></group>
    <group id="dialog"><unit id="close"><segment><source>Close</source></segment></unit></group>
  </file>
</xliff>`), "messages.xliff", "xliff")
    expect(xliff.orderedMilestones.map(({ milestone }) => milestone.label)).toEqual([
      "app: menu",
      "app: dialog",
    ])
  })
})
