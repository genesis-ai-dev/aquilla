/**
 * Synthetic IDML builder for tests, the demo and the acceptance gate.
 *
 * Produces structurally realistic packages (UCF mimetype first, designmap,
 * styles with BasedOn, spreads with path-geometry text frames and threading,
 * stories with character-style runs, inline objects, tables, footnotes and
 * hyperlinks). Real InDesign exports in fixtures/third-party/ complement this.
 */
import { encodeAttr, encodeText } from "../adapters/xml.ts"
import { buildZip } from "../adapters/zip.ts"

export type Run = { readonly style?: string; readonly text: string } | { readonly inline: "variable" | "anchored" | "pi" }

export interface ParagraphSpec {
  readonly style?: string
  readonly runs: readonly Run[]
  readonly footnote?: string
}

export interface TableSpec {
  readonly table: readonly (readonly string[])[]
}

export interface StorySpec {
  readonly id: string
  readonly paragraphs: ReadonlyArray<ParagraphSpec | TableSpec | string>
  /** Frame size in points; omit for an unplaced story. Two-element array threads two frames. */
  readonly frames?: ReadonlyArray<{ readonly width: number; readonly height: number; readonly columns?: number }>
  readonly master?: boolean
}

export interface IdmlSpec {
  readonly stories: readonly StorySpec[]
  readonly bodySize?: number
}

const para = (p: ParagraphSpec | string): ParagraphSpec => (typeof p === "string" ? { runs: [{ text: p }] } : p)
const isTable = (p: ParagraphSpec | TableSpec | string): p is TableSpec => typeof p === "object" && "table" in p

const csr = (style: string, inner: string): string =>
  `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${encodeAttr(style)}">${inner}</CharacterStyleRange>`

const storyXml = (s: StorySpec): string => {
  let n = 0
  const body = s.paragraphs
    .map((p, i) => {
      const last = i === s.paragraphs.length - 1
      if (isTable(p)) {
        const cells = p.table
          .flatMap((row, r) =>
            row.map(
              (cell, c) =>
                `<Cell Self="${s.id}c${r}_${c}_${n++}" Name="${c}:${r}"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">${csr("$ID/[No character style]", `<Content>${encodeText(cell)}</Content>`)}</ParagraphStyleRange></Cell>`,
            ),
          )
          .join("")
        return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">${csr("$ID/[No character style]", `<Table Self="${s.id}t${n++}" BodyRowCount="${p.table.length}" ColumnCount="${p.table[0]?.length ?? 0}">${cells}</Table>${last ? "" : "<Br/>"}`)}</ParagraphStyleRange>`
      }
      const q = para(p)
      const runs = q.runs
        .map((r) => {
          if ("inline" in r) {
            if (r.inline === "variable") return csr("$ID/[No character style]", `<TextVariableInstance Self="${s.id}v${n++}" ResultText="1" AssociatedTextVariable="TextVariable/Page"/>`)
            if (r.inline === "anchored") return csr("$ID/[No character style]", `<Rectangle Self="${s.id}r${n++}" ContentType="GraphicType"/>`)
            return csr("$ID/[No character style]", `<Content><?ACE 7?></Content>`)
          }
          return csr(r.style ?? "$ID/[No character style]", `<Content>${encodeText(r.text)}</Content>`)
        })
        .join("")
      const fn = q.footnote
        ? csr(
            "$ID/[No character style]",
            `<Footnote Self="${s.id}f${n++}"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Footnote">${csr("$ID/[No character style]", `<Content><?ACE 4?></Content><Content>${encodeText(q.footnote)}</Content>`)}</ParagraphStyleRange></Footnote>`,
          )
        : ""
      const br = last ? "" : csr("$ID/[No character style]", "<Br/>")
      return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/${encodeAttr(q.style ?? "Body")}">${runs}${fn}${br}</ParagraphStyleRange>`
    })
    .join("\n\t\t")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0">
\t<Story Self="${s.id}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">
\t\t<StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection"/>
\t\t<InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
\t\t${body}
\t</Story>
</idPkg:Story>
`
}

const frameXml = (storyId: string, k: number, total: number, f: { width: number; height: number; columns?: number }, x: number): string => {
  const id = `${storyId}_tf${k}`
  const prev = k > 0 ? `${storyId}_tf${k - 1}` : "n"
  const next = k < total - 1 ? `${storyId}_tf${k + 1}` : "n"
  const w = f.width / 2
  const h = f.height / 2
  return `<TextFrame Self="${id}" ParentStory="${storyId}" PreviousTextFrame="${prev}" NextTextFrame="${next}" ContentType="TextType" ItemTransform="1 0 0 1 ${x} 0">
\t\t\t<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>
\t\t\t\t<PathPointType Anchor="${-w} ${-h}" LeftDirection="${-w} ${-h}" RightDirection="${-w} ${-h}"/>
\t\t\t\t<PathPointType Anchor="${-w} ${h}" LeftDirection="${-w} ${h}" RightDirection="${-w} ${h}"/>
\t\t\t\t<PathPointType Anchor="${w} ${h}" LeftDirection="${w} ${h}" RightDirection="${w} ${h}"/>
\t\t\t\t<PathPointType Anchor="${w} ${-h}" LeftDirection="${w} ${-h}" RightDirection="${w} ${-h}"/>
\t\t\t</PathPointArray></GeometryPathType></PathGeometry></Properties>
\t\t\t<TextFramePreference TextColumnCount="${f.columns ?? 1}" TextColumnGutter="12" InsetSpacing="0 0 0 0"/>
\t\t</TextFrame>`
}

export const buildIdml = (spec: IdmlSpec): Uint8Array => {
  const size = spec.bodySize ?? 11
  const placed = spec.stories.filter((s) => s.frames && !s.master)
  const masters = spec.stories.filter((s) => s.frames && s.master)
  let x = 0
  const frames = (list: readonly StorySpec[]): string =>
    list
      .flatMap((s) =>
        s.frames!.map((f, k) => {
          const xml = frameXml(s.id, k, s.frames!.length, f, x)
          x += f.width + 20
          return xml
        }),
      )
      .join("\n\t\t")
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0">
\t<Spread Self="sp1" PageCount="1" ItemTransform="1 0 0 1 0 0">
\t\t<Page Self="pg1" Name="1" AppliedMaster="ms1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
\t\t${frames(placed)}
\t</Spread>
</idPkg:Spread>
`
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:MasterSpread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0">
\t<MasterSpread Self="ms1" Name="A-Master" NamePrefix="A" BaseName="Master" PageCount="1">
\t\t<Page Self="mpg1" Name="A" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
\t\t${frames(masters)}
\t</MasterSpread>
</idPkg:MasterSpread>
`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0">
\t<RootCharacterStyleGroup Self="csg"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/><CharacterStyle Self="CharacterStyle/Bold" Name="Bold" FontStyle="Bold"/><CharacterStyle Self="CharacterStyle/Italic" Name="Italic" FontStyle="Italic"/></RootCharacterStyleGroup>
\t<RootParagraphStyleGroup Self="psg">
\t\t<ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" PointSize="12"/>
\t\t<ParagraphStyle Self="ParagraphStyle/Body" Name="Body" PointSize="${size}" Leading="${size * 1.25}"><Properties><BasedOn type="object">ParagraphStyle/$ID/NormalParagraphStyle</BasedOn></Properties></ParagraphStyle>
\t\t<ParagraphStyle Self="ParagraphStyle/Heading" Name="Heading" PointSize="${size * 2}"><Properties><BasedOn type="object">ParagraphStyle/Body</BasedOn></Properties></ParagraphStyle>
\t\t<ParagraphStyle Self="ParagraphStyle/Footnote" Name="Footnote" PointSize="8"/>
\t</RootParagraphStyleGroup>
</idPkg:Styles>
`
  const designmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="18.0(1)" ?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0" Self="d">
\t<idPkg:Graphic src="Resources/Graphic.xml"/>
\t<idPkg:Styles src="Resources/Styles.xml"/>
\t<idPkg:Preferences src="Resources/Preferences.xml"/>
\t<idPkg:MasterSpread src="MasterSpreads/MasterSpread_ms1.xml"/>
\t<idPkg:Spread src="Spreads/Spread_sp1.xml"/>
${spec.stories.map((s) => `\t<idPkg:Story src="Stories/Story_${s.id}.xml"/>`).join("\n")}
</Document>
`
  const files: Array<[string, string]> = [
    ["mimetype", "application/vnd.adobe.indesign-idml-package"],
    ["designmap.xml", designmap],
    [
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>\n`,
    ],
    ["Resources/Graphic.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0"><Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/></idPkg:Graphic>\n`],
    ["Resources/Styles.xml", styles],
    ["Resources/Preferences.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Preferences xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0"><DocumentPreference PageHeight="792" PageWidth="612"/></idPkg:Preferences>\n`],
    ["MasterSpreads/MasterSpread_ms1.xml", master],
    ["Spreads/Spread_sp1.xml", spread],
    ...spec.stories.map((s): [string, string] => [`Stories/Story_${s.id}.xml`, storyXml(s)]),
  ]
  return buildZip(files)
}

/** A small but representative brochure used by the demo and tests. */
export const brochureSpec = (overrides: Partial<Record<string, ReadonlyArray<ParagraphSpec | TableSpec | string>>> = {}): IdmlSpec => ({
  stories: [
    {
      id: "u100",
      frames: [{ width: 460, height: 90 }],
      paragraphs: overrides.u100 ?? [{ style: "Heading", runs: [{ text: "Community Choir Season Guide" }] }],
    },
    {
      id: "u200",
      frames: [
        { width: 220, height: 300 },
        { width: 220, height: 300 },
      ],
      paragraphs: overrides.u200 ?? [
        { runs: [{ text: "Welcome to a new season of the " }, { style: "Bold", text: "Community Choir" }, { text: ". Everyone who loves to sing is welcome, whatever their experience." }] },
        "Rehearsals take place every Thursday evening in the church hall, starting at seven o'clock.",
        { runs: [{ text: "Bring water, a pencil, and your music folder. Page " }, { inline: "variable" }, { text: " lists the full schedule." }], footnote: "Parking is free after six o'clock." },
        "Our spring concert will feature music from four centuries, including two new commissions.",
        { table: [["Month", "Focus"], ["September", "Warm-ups and sight reading"], ["October", "Spring concert repertoire"]] },
        "Questions? Speak to any section leader after rehearsal, or write to the choir office.",
      ],
    },
    {
      id: "u300",
      master: true,
      frames: [{ width: 400, height: 20 }],
      paragraphs: overrides.u300 ?? ["Community Choir — Season Guide"],
    },
  ],
})
