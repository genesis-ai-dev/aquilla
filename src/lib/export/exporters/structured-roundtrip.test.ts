// Unit tests for the structure-preserving CAT exporters (Matecat-parity run).
// These are NEW exporters; the legacy exportPlainText/exportMarkdown/exportVtt
// stay byte-identical and keep their own tests (C7).
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { exportPlainTextStructured } from "./plaintext"
import { exportMarkdownStructured } from "./markdown"
import { exportSrt, formatSrtTime } from "./srt"
import { exportVttStructured, formatVttTimeFull } from "./vtt-structured"

interface CellOverrides extends Partial<CellData> {
  speaker?: string
}

function cell(o: CellOverrides): CellData {
  return {
    id: o.id ?? "c1",
    fileId: "f1",
    original: o.original ?? "",
    translated: o.translated ?? "",
    group: o.group ?? o.id ?? "g1",
    context: o.context ?? "",
    type: o.type ?? "text",
    status: "unvalidated",
    validationStatus: "unvalidated",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...o,
  } as CellData
}

const blobText = (b: Blob): Promise<string> => b.text()

describe("exportPlainTextStructured", () => {
  it("separates paragraphs with blank lines and rejoins same-group segments", async () => {
    const out = await blobText(
      exportPlainTextStructured([
        cell({ id: "a", group: "p1", translated: "Première phrase." }),
        cell({ id: "b", group: "p1", translated: "Deuxième phrase." }),
        cell({ id: "c", group: "p2", translated: "Nouveau paragraphe." }),
      ]),
    )
    expect(out).toBe("Première phrase. Deuxième phrase.\n\nNouveau paragraphe.\n")
  })

  it("falls back to source for untranslated cells", async () => {
    const out = await blobText(
      exportPlainTextStructured([
        cell({ id: "a", group: "p1", original: "Untranslated source.", translated: "" }),
      ]),
    )
    expect(out).toBe("Untranslated source.\n")
  })
})

describe("exportMarkdownStructured", () => {
  it("reconstructs heading levels, list items and blockquotes", async () => {
    const out = await blobText(
      exportMarkdownStructured([
        cell({ id: "h", type: "heading", context: "Heading 2", translated: "Titre" }),
        cell({ id: "l1", type: "list", context: "List item", translated: "Premier" }),
        cell({ id: "q", type: "blockquote", context: "Blockquote", translated: "Citation" }),
        cell({ id: "p", type: "text", context: "Paragraph", translated: "Corps du texte." }),
      ]),
    )
    expect(out).toBe("## Titre\n\n- Premier\n\n> Citation\n\nCorps du texte.\n")
  })

  it("emits no anchor comments (they would re-import as text)", async () => {
    const out = await blobText(
      exportMarkdownStructured([cell({ id: "p", group: "GEN 1:1", translated: "Texte." })]),
    )
    expect(out).not.toContain("<!--")
  })
})

describe("exportSrt", () => {
  it("formats numbered cues with comma-millisecond timecodes", async () => {
    const out = await blobText(
      exportSrt([
        cell({ id: "1", translated: "Bonjour.", startTime: 1.5, endTime: 3.25 }),
        cell({ id: "2", translated: "Ligne 1\nLigne 2", startTime: 4, endTime: 6.001 }),
      ]),
    )
    expect(out).toBe("1\n00:00:01,500 --> 00:00:03,250\nBonjour.\n\n2\n00:00:04,000 --> 00:00:06,001\nLigne 1\nLigne 2\n")
  })

  it("skips untimed cells and preserves inline subtitle tags", async () => {
    const out = await blobText(
      exportSrt([
        cell({ id: "no-time", translated: "dropped" }),
        cell({ id: "1", translated: "<i>italique</i>", startTime: 0, endTime: 1 }),
      ]),
    )
    expect(out).toBe("1\n00:00:00,000 --> 00:00:01,000\n<i>italique</i>\n")
  })

  it("formatSrtTime rolls hours past 99 minutes", () => {
    expect(formatSrtTime(3661.007)).toBe("01:01:01,007")
  })
})

describe("exportVttStructured", () => {
  it("re-emits imported speaker labels as <v> tags and keeps payload tags", async () => {
    const out = await blobText(
      exportVttStructured([
        cell({ id: "1", translated: "Salut <b>toi</b>", startTime: 0.5, endTime: 2, speaker: "Ana" }),
        cell({ id: "2", translated: "Sans voix", startTime: 3, endTime: 4 }),
      ]),
    )
    expect(out).toBe(
      "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n<v Ana>Salut <b>toi</b></v>\n\n00:00:03.000 --> 00:00:04.000\nSans voix\n",
    )
  })

  it("formatVttTimeFull always emits the hours field", () => {
    expect(formatVttTimeFull(65.25)).toBe("00:01:05.250")
  })
})
