import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import JSZip from "jszip"

import { parseIdml } from "../src/engine.js"
import { sha256 } from "../src/crypto.js"

const MIMETYPE = "application/vnd.adobe.indesign-idml-package"
const FIXTURE_DATE = new Date("2024-01-01T00:00:00.000Z")
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CORPUS_ROOT = resolve(PACKAGE_ROOT, "fixtures")
const CHECK_ONLY = process.argv.includes("--check")
const encoder = new TextEncoder()

type FixtureValue = string | Uint8Array

interface ArchiveEntry {
  readonly name: string
  readonly data: FixtureValue
  readonly flags?: number
  readonly compressionMethod?: number
  readonly declaredUncompressedSize?: number
}

interface CorpusFile {
  readonly path: string
  readonly bytes: Uint8Array
}

function deterministicLongText(length: number): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 العربية 漢字かな क्\u200dषेत्र "
  let state = 0x6d2b79f5
  let value = ""
  while (value.length < length) {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    const index = ((state ^ (state >>> 14)) >>> 0) % alphabet.length
    value += alphabet[index]
  }
  return value.slice(0, length)
}

const mixedParagraph = [
  '<ParagraphStyleRange Self="p-mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
  '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>  Bold &amp; preserved  </Content><Content>ثُمَّ RTL</Content></CharacterStyleRange>',
  '<HyperlinkTextSource Self="hyperlink-source"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Italic"><Content>漢字とかな</Content><Br/><Content>क्‍षेत्र é</Content><CrossReferenceSource Self="xref-source"/><TextVariableInstance Self="variable-instance"/><Rectangle Self="inline-rectangle"><Image Self="embedded-image"/></Rectangle><Mystery Self="unknown-inline"/><Content></Content></CharacterStyleRange></HyperlinkTextSource>',
  '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Underline"><Content>one\ttwo\t</Content></CharacterStyleRange>',
  '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><TextFrame Self="anchored-frame" ParentStory="story-anchored"/></CharacterStyleRange>',
  "</ParagraphStyleRange>",
].join("")

const mainStory = [
  '<?xml version="1.0" encoding="UTF-8"?>\r\n',
  '<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">\r\n',
  '<Story Self="story-main">\r\n',
  mixedParagraph,
  "\r\n",
  '<Table Self="outer-table"><Cell Self="outer-cell" Name="0:0"><ParagraphStyleRange Self="p-table-outer" AppliedParagraphStyle="ParagraphStyle/Table"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Table"><Content>outer cell</Content></CharacterStyleRange><Table Self="inner-table"><Cell Self="inner-cell" Name="0:0"><ParagraphStyleRange Self="p-table-inner" AppliedParagraphStyle="ParagraphStyle/Table"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Table"><Content>nested cell</Content></CharacterStyleRange></ParagraphStyleRange></Cell></Table></ParagraphStyleRange></Cell></Table>\r\n',
  '<Footnote Self="footnote-1"><ParagraphStyleRange Self="p-footnote"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Footnote"><Content>foot&amp;note</Content></CharacterStyleRange></ParagraphStyleRange></Footnote>\r\n',
  '<EndnoteRange Self="endnote-1"><ParagraphStyleRange Self="p-endnote"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Endnote"><Content>endnote</Content></CharacterStyleRange></ParagraphStyleRange></EndnoteRange>\r\n',
  '<Note Self="note-1"><ParagraphStyleRange Self="p-note"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Note"><Content>translator note</Content></CharacterStyleRange></ParagraphStyleRange></Note>\r\n',
  '<ParagraphStyleRange Self="p-processing"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content><?ACE 3?>literal text after marker</Content><Content>left<?ACE 7?>right</Content></CharacterStyleRange></ParagraphStyleRange>\r\n',
  '<ParagraphStyleRange Self="p-terminator"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>soft</Content><Br/><Content>return&#13;marker</Content></CharacterStyleRange></ParagraphStyleRange>\r\n',
  "</Story>\r\n",
  "</idPkg:Story>\r\n",
].join("")

const longText = deterministicLongText(24_000)

const featureMembers: Readonly<Record<string, FixtureValue>> = {
  "designmap.xml": [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<idPkg:DesignMap xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">',
    '<idPkg:Story src="Stories/Story_main.xml"/>',
    '<idPkg:Story src="Stories/Story_threaded.xml"/>',
    '<idPkg:Story src="Stories/Story_anchored.xml"/>',
    '<idPkg:Story src="Stories/Story_path.xml"/>',
    '<idPkg:Story src="Stories/Story_master.xml"/>',
    '<idPkg:Story src="Stories/Story_long.xml"/>',
    '<idPkg:Spread src="Spreads/Spread_main.xml"/>',
    '<idPkg:MasterSpread src="MasterSpreads/MasterSpread_master.xml"/>',
    '<idPkg:Layer src="Resources/Layers.xml"/>',
    '<idPkg:TextVariable src="Resources/TextVariables.xml"/>',
    "</idPkg:DesignMap>",
  ].join(""),
  "Stories/Story_main.xml": mainStory,
  "Stories/Story_threaded.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-threaded"><ParagraphStyleRange Self="p-threaded"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>threaded frames</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>',
  "Stories/Story_anchored.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-anchored"><ParagraphStyleRange Self="p-anchored"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>anchored story</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>',
  "Stories/Story_path.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-path"><ParagraphStyleRange Self="p-text-path"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Path"><Content>text on a path</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>',
  "Stories/Story_master.xml": new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-master"><ParagraphStyleRange Self="p-master"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Master"><Content>master page story</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>\n',
    ),
  ]),
  "Stories/Story_long.xml": `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-long"><ParagraphStyleRange Self="p-long"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>${longText}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
  "Stories/Story_remaining.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="story-remaining"><ParagraphStyleRange Self="p-remaining"><CharacterStyleRange><Content>unlisted remaining story</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>',
  "Spreads/Spread_main.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Spread xmlns:idPkg="urn:test"><Spread Self="spread-main" ItemTransform="1 0 0 1 0 0"><Page Self="page-1" Name="1" AppliedMaster="master-spread" GeometricBounds="0 0 792 612"/><Page Self="page-2" Name="2" AppliedMaster="master-spread" GeometricBounds="0 612 792 1224"/><TextFrame Self="thread-frame-1" ParentStory="story-threaded" NextTextFrame="thread-frame-2" ItemTransform="1 0 0 1 36 36"/><TextFrame Self="thread-frame-2" ParentStory="story-threaded" PreviousTextFrame="thread-frame-1" ItemTransform="1 0 0 1 648 36"/><TextPath Self="path-frame" ParentStory="story-path"/><TextFrame Self="main-frame" ParentStory="story-main" ItemTransform="1 0 0 1 72 72"/></Spread></idPkg:Spread>',
  "MasterSpreads/MasterSpread_master.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:MasterSpread xmlns:idPkg="urn:test"><MasterSpread Self="master-spread" Name="A-Master"><Page Self="master-page" Name="A" GeometricBounds="0 0 792 612"/><TextFrame Self="master-frame" ParentStory="story-master" ItemTransform="1 0 0 1 36 36"/></MasterSpread></idPkg:MasterSpread>',
  "Resources/TextVariables.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:TextVariables xmlns:idPkg="urn:test"><TextVariable Self="TextVariable/Custom" VariableType="CustomTextType"><Contents>literal custom variable</Contents></TextVariable><TextVariable Self="TextVariable/Page" VariableType="PageNumberType"><Contents>1</Contents></TextVariable><TextVariable Self="TextVariable/Date" VariableType="ModificationDateType"><Contents>2024-01-01</Contents></TextVariable></idPkg:TextVariables>',
  "Resources/Styles.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Styles xmlns:idPkg="urn:test"><RootParagraphStyleGroup><ParagraphStyle Self="ParagraphStyle/Body"/><ParagraphStyle Self="ParagraphStyle/Table"/></RootParagraphStyleGroup><RootCharacterStyleGroup><CharacterStyle Self="CharacterStyle/Bold" FontStyle="Bold"/><CharacterStyle Self="CharacterStyle/Italic" FontStyle="Italic"/><CharacterStyle Self="CharacterStyle/Underline" Underline="true"/></RootCharacterStyleGroup></idPkg:Styles>',
  "Resources/Hyperlinks.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Hyperlinks xmlns:idPkg="urn:test"><Hyperlink Self="hyperlink-1" Source="hyperlink-source" Destination="url-1"/><HyperlinkURLDestination Self="url-1" DestinationURL="https://example.invalid/generated"/><CrossReferenceFormat Self="xref-format"/></idPkg:Hyperlinks>',
  "Resources/Graphic.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Graphic xmlns:idPkg="urn:test"><Swatch Self="Color/Generated"/><LinkResourceURI Self="Links/generated-image.png"/></idPkg:Graphic>',
  "Resources/Layers.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Layers xmlns:idPkg="urn:test"><Layer Self="layer-text" Name="Generated text"/><Layer Self="layer-assets" Name="Generated assets"/></idPkg:Layers>',
  "Links/generated-image.png": generatedPng(),
}

const biblicaParagraph =
  '<ParagraphStyleRange Self="biblica-p1" AppliedParagraphStyle="ParagraphStyle/Scripture"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Vernacular"><Content>In the beginning</Content><Content> was the Word</Content></CharacterStyleRange></ParagraphStyleRange>'

const biblicaMembers: Readonly<Record<string, FixtureValue>> = {
  "designmap.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:DesignMap xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging"><idPkg:Story src="Stories/Story_biblica.xml"/></idPkg:DesignMap>',
  "Stories/Story_biblica.xml": `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="biblica-story">${biblicaParagraph}<ParagraphStyleRange Self="biblica-p2" AppliedParagraphStyle="ParagraphStyle/Footnote"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Note"><Content>generated Biblica semantic-profile fixture</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
  "Resources/Styles.xml":
    '<?xml version="1.0" encoding="UTF-8"?><idPkg:Styles xmlns:idPkg="urn:test"><ParagraphStyle Self="ParagraphStyle/Scripture"/><CharacterStyle Self="CharacterStyle/Vernacular"/></idPkg:Styles>',
}

async function makeIdml(
  members: Readonly<Record<string, FixtureValue>>,
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("mimetype", MIMETYPE, {
    compression: "STORE",
    createFolders: false,
    date: FIXTURE_DATE,
  })
  for (const [path, value] of Object.entries(members)) {
    zip.file(path, value, {
      binary: value instanceof Uint8Array,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      createFolders: false,
      date: FIXTURE_DATE,
    })
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
    streamFiles: false,
  })
}

function makeStoredZip(entries: readonly ArchiveEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  const prepared: Array<{
    readonly entry: ArchiveEntry
    readonly name: Uint8Array
    readonly data: Uint8Array
    readonly offset: number
    readonly crc: number
  }> = []
  let localOffset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data
    const header = new Uint8Array(30 + name.byteLength)
    const view = new DataView(header.buffer)
    const flags = entry.flags ?? 0x0800
    const method = entry.compressionMethod ?? 0
    const crc = crc32(data)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, flags, true)
    view.setUint16(8, method, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, data.byteLength, true)
    view.setUint32(22, entry.declaredUncompressedSize ?? data.byteLength, true)
    view.setUint16(26, name.byteLength, true)
    header.set(name, 30)
    localChunks.push(header, data)
    prepared.push({ entry, name, data, offset: localOffset, crc })
    localOffset += header.byteLength + data.byteLength
  }

  for (const item of prepared) {
    const header = new Uint8Array(46 + item.name.byteLength)
    const view = new DataView(header.buffer)
    const flags = item.entry.flags ?? 0x0800
    const method = item.entry.compressionMethod ?? 0
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, flags, true)
    view.setUint16(10, method, true)
    view.setUint32(16, item.crc, true)
    view.setUint32(20, item.data.byteLength, true)
    view.setUint32(24, item.entry.declaredUncompressedSize ?? item.data.byteLength, true)
    view.setUint16(28, item.name.byteLength, true)
    view.setUint32(42, item.offset, true)
    header.set(item.name, 46)
    centralChunks.push(header)
  }

  const central = concatenate(centralChunks)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, central.byteLength, true)
  endView.setUint32(16, localOffset, true)
  return concatenate([...localChunks, central, end])
}

function baseSecurityEntries(extra: readonly ArchiveEntry[] = []): ArchiveEntry[] {
  return [
    { name: "mimetype", data: MIMETYPE },
    { name: "designmap.xml", data: "<Document/>" },
    ...extra,
  ]
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function generatedPng(): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, 1)
  ihdrView.setUint32(4, 1)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const scanline = Uint8Array.from([0, 0x25, 0x74, 0xa9, 0xff])
  const deflate = new Uint8Array(2 + 5 + scanline.byteLength + 4)
  deflate.set([0x78, 0x01, 0x01, scanline.byteLength, 0, 0xfa, 0xff], 0)
  deflate.set(scanline, 7)
  new DataView(deflate.buffer).setUint32(deflate.byteLength - 4, adler32(scanline))
  return concatenate([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflate),
    pngChunk("IEND", new Uint8Array()),
  ])
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type)
  const result = new Uint8Array(12 + data.byteLength)
  const view = new DataView(result.buffer)
  view.setUint32(0, data.byteLength)
  result.set(typeBytes, 4)
  result.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(concatenate([typeBytes, data])))
  return result
}

function adler32(bytes: Uint8Array): number {
  let first = 1
  let second = 0
  for (const byte of bytes) {
    first = (first + byte) % 65_521
    second = (second + first) % 65_521
  }
  return ((second << 16) | first) >>> 0
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0)
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}

async function corpusFiles(): Promise<{
  readonly files: readonly CorpusFile[]
  readonly manifest: Record<string, unknown>
}> {
  const featureRich = await makeIdml(featureMembers)
  const biblica = await makeIdml(biblicaMembers)
  const malformedXml = await makeIdml({
    ...featureMembers,
    "Resources/Styles.xml": "<Styles><Broken></Styles>",
  })
  const unsafeXml = await makeIdml({
    ...biblicaMembers,
    "Resources/Styles.xml":
      '<!DOCTYPE Styles [<!ENTITY generated "unsafe">]><Styles>&generated;</Styles>',
  })
  const compressionBomb = await makeIdml({
    ...biblicaMembers,
    "Resources/GeneratedBomb.xml": `<Root>${"A".repeat(64 * 1024)}</Root>`,
  })
  const corruptZip = featureRich.slice(0, featureRich.byteLength - 17)
  const duplicateMember = makeStoredZip([
    ...baseSecurityEntries(),
    { name: "designmap.xml", data: "<OtherDocument/>" },
  ])
  const unsafePath = makeStoredZip(
    baseSecurityEntries([{ name: "../Stories/escape.xml", data: "<Story/>" }]),
  )
  const encryptedMember = makeStoredZip([
    { name: "mimetype", data: MIMETYPE },
    { name: "designmap.xml", data: "<Document/>", flags: 0x0801 },
  ])
  const unsupportedCompression = makeStoredZip([
    { name: "mimetype", data: MIMETYPE },
    { name: "designmap.xml", data: "<Document/>", compressionMethod: 99 },
  ])
  const missingDesignmap = makeStoredZip([
    { name: "mimetype", data: MIMETYPE },
  ])
  const invalidMimetype = makeStoredZip([
    { name: "mimetype", data: "application/octet-stream" },
    { name: "designmap.xml", data: "<Document/>" },
  ])

  const parsed = await parseIdml(featureRich)
  const biblicaParsed = await parseIdml(biblica)
  const mixedUnit = parsed.units.find((unit) => unit.locator.elementId === "p-mixed")
  const legacyUnit = biblicaParsed.units.find(
    (unit) => unit.locator.elementId === "biblica-p1",
  )
  if (!mixedUnit) throw new Error("Generated feature fixture is missing p-mixed")
  if (!legacyUnit) throw new Error("Generated Biblica fixture is missing biblica-p1")
  const legacyCell = {
    valueHtml: [
      '<p class="indesign-paragraph" data-paragraph-style="ParagraphStyle/Scripture" data-story-id="biblica-story" data-segment-count="2">',
      '<span class="idml-segment" data-segment-index="0" data-character-style="CharacterStyle/Vernacular">In the beginning</span>',
      '<span class="idml-eoc" data-eoc="1" aria-hidden="true"></span>',
      '<span class="idml-segment" data-segment-index="1" data-character-style="CharacterStyle/Vernacular"> was the Word</span>',
      "</p>",
    ].join(""),
    metadata: {
      storyId: "biblica-story",
      paragraphId: "biblica-p1",
      data: {
        idmlStructure: {
          storyId: "biblica-story",
          paragraphId: "biblica-p1",
          contentSegments: legacyUnit.slots.map((slot) => slot.text),
          contentSegmentCount: legacyUnit.slots.length,
          contentSegmentBreakBefore: legacyUnit.slots.map(() => false),
          sourceBlockXml: biblicaParagraph,
          paragraphStyleRange: {
            appliedParagraphStyle: "ParagraphStyle/Scripture",
          },
        },
        relationships: {
          parentStory: "biblica-story",
          storyOrder: 0,
          paragraphOrder: 0,
        },
      },
    },
  }
  const v2Cell = {
    locator: mixedUnit.locator,
    metadata: mixedUnit.metadata,
    sourceHtml: mixedUnit.sourceHtml,
    targetHtml: mixedUnit.sourceHtml.replace("漢字とかな", "translated CJK"),
  }
  const staleLocator = {
    ...v2Cell,
    locator: {
      ...mixedUnit.locator,
      sourceBlockHash: "0".repeat(64),
    },
  }

  const rawFiles: CorpusFile[] = [
    { path: "valid/feature-rich.idml", bytes: featureRich },
    { path: "valid/biblica-profile.idml", bytes: biblica },
    { path: "invalid/malformed-xml.idml", bytes: malformedXml },
    { path: "invalid/doctype-entity.idml", bytes: unsafeXml },
    { path: "invalid/corrupt-zip.idml", bytes: corruptZip },
    { path: "invalid/duplicate-member.idml", bytes: duplicateMember },
    { path: "invalid/unsafe-path.idml", bytes: unsafePath },
    { path: "invalid/encrypted-member.idml", bytes: encryptedMember },
    { path: "invalid/unsupported-compression.idml", bytes: unsupportedCompression },
    { path: "invalid/missing-designmap.idml", bytes: missingDesignmap },
    { path: "invalid/invalid-mimetype.idml", bytes: invalidMimetype },
    { path: "invalid/compression-bomb.idml", bytes: compressionBomb },
    {
      path: "metadata/legacy-codex.json",
      bytes: encoder.encode(`${JSON.stringify(legacyCell, null, 2)}\n`),
    },
    {
      path: "metadata/v2-cell.json",
      bytes: encoder.encode(`${JSON.stringify(v2Cell, null, 2)}\n`),
    },
    {
      path: "metadata/stale-locator.json",
      bytes: encoder.encode(`${JSON.stringify(staleLocator, null, 2)}\n`),
    },
  ]

  const hashes = new Map<string, string>()
  for (const file of rawFiles) hashes.set(file.path, await sha256(file.bytes))
  const manifest = {
    version: 1,
    generated: true,
    license: "CC0-1.0",
    generator: "scripts/generate-corpus.ts",
    valid: [
      {
        path: "valid/feature-rich.idml",
        sha256: hashes.get("valid/feature-rich.idml"),
        profiles: ["generic", "biblica"],
        expectedScopes: [
          "story-paragraph",
          "table-cell",
          "footnote",
          "endnote",
          "note",
          "anchored-story",
          "text-path",
          "master-story",
          "custom-variable",
        ],
      },
      {
        path: "valid/biblica-profile.idml",
        sha256: hashes.get("valid/biblica-profile.idml"),
        profiles: ["generic", "biblica"],
        expectedUnitIds: ["biblica-p1", "biblica-p2"],
      },
    ],
    invalid: [
      {
        path: "invalid/malformed-xml.idml",
        sha256: hashes.get("invalid/malformed-xml.idml"),
        operation: "parse",
        errorCode: "MALFORMED_XML",
      },
      {
        path: "invalid/doctype-entity.idml",
        sha256: hashes.get("invalid/doctype-entity.idml"),
        operation: "parse",
        errorCode: "UNSAFE_XML_DECLARATION",
      },
      {
        path: "invalid/corrupt-zip.idml",
        sha256: hashes.get("invalid/corrupt-zip.idml"),
        operation: "inspect",
        errorCode: "INVALID_ZIP",
      },
      {
        path: "invalid/duplicate-member.idml",
        sha256: hashes.get("invalid/duplicate-member.idml"),
        operation: "inspect",
        errorCode: "DUPLICATE_MEMBER",
      },
      {
        path: "invalid/unsafe-path.idml",
        sha256: hashes.get("invalid/unsafe-path.idml"),
        operation: "inspect",
        errorCode: "UNSAFE_MEMBER_PATH",
      },
      {
        path: "invalid/encrypted-member.idml",
        sha256: hashes.get("invalid/encrypted-member.idml"),
        operation: "inspect",
        errorCode: "ENCRYPTED_MEMBER",
      },
      {
        path: "invalid/unsupported-compression.idml",
        sha256: hashes.get("invalid/unsupported-compression.idml"),
        operation: "inspect",
        errorCode: "UNSUPPORTED_COMPRESSION",
      },
      {
        path: "invalid/missing-designmap.idml",
        sha256: hashes.get("invalid/missing-designmap.idml"),
        operation: "inspect",
        errorCode: "MISSING_DESIGNMAP",
      },
      {
        path: "invalid/invalid-mimetype.idml",
        sha256: hashes.get("invalid/invalid-mimetype.idml"),
        operation: "inspect",
        errorCode: "INVALID_MIMETYPE",
      },
      {
        path: "invalid/compression-bomb.idml",
        sha256: hashes.get("invalid/compression-bomb.idml"),
        operation: "inspect",
        errorCode: "COMPRESSION_RATIO_EXCEEDED",
        limits: { maxCompressionRatio: 20 },
      },
    ],
    metadata: [
      {
        path: "metadata/legacy-codex.json",
        sha256: hashes.get("metadata/legacy-codex.json"),
        expected: "upgradeable",
      },
      {
        path: "metadata/v2-cell.json",
        sha256: hashes.get("metadata/v2-cell.json"),
        expected: "v2",
      },
      {
        path: "metadata/stale-locator.json",
        sha256: hashes.get("metadata/stale-locator.json"),
        expected: "export-rejected",
      },
    ],
  }
  return { files: rawFiles, manifest }
}

async function emitFile(path: string, bytes: Uint8Array): Promise<void> {
  const outputPath = resolve(CORPUS_ROOT, path)
  if (CHECK_ONLY) {
    const existing = new Uint8Array(await readFile(outputPath))
    if (
      existing.byteLength !== bytes.byteLength ||
      existing.some((byte, index) => byte !== bytes[index])
    ) {
      throw new Error(`Generated fixture is stale: ${path}`)
    }
    return
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bytes)
}

async function main(): Promise<void> {
  const { files, manifest } = await corpusFiles()
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)
  for (const file of files) await emitFile(file.path, file.bytes)
  await emitFile("manifest.json", manifestBytes)
  process.stdout.write(
    `${CHECK_ONLY ? "Verified" : "Generated"} ${files.length} IDML corpus files and manifest\n`,
  )
}

await main()
