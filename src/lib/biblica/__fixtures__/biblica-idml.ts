/**
 * Minimal Biblica study-Bible IDML packages for tests.
 *
 * The shapes mirror how Biblica InDesign templates actually mark up a study
 * Bible: a `meta:bk` paragraph names the book, `cv:dc` drop caps open chapters,
 * `cv:v` + paired `meta:v` bookends delimit each verse body, and the study notes
 * live in `intro:*` paragraphs. InDesign URL-encodes the colon, so the fixtures
 * use the `%3a` form that real documents contain.
 */

import JSZip from "jszip"

const MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

export const BIBLICA_STORY_PATH = "Stories/Story_u1.xml"

/** One `<CharacterStyleRange>` holding one `<Content>` run per text argument. */
export function run(characterStyle: string, ...texts: string[]): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${characterStyle}">`
    + texts.map((text) => `<Content>${text}</Content>`).join("")
    + `</CharacterStyleRange>`
}

export function paragraph(self: string, paragraphStyle: string, inner: string): string {
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="ParagraphStyle/${paragraphStyle}">`
    + inner
    + `</ParagraphStyleRange>`
}

const PLAIN = "$ID/[No character style]"

/** `[cv:v N][meta:v N] body [meta:v N]` — a verse that opens and closes in place. */
export function closedVerse(self: string, verse: string, body: string, chapter?: string): string {
  return paragraph(
    self,
    "cv%3ap",
    (chapter ? run("cv%3adc", chapter) : "")
      + run("cv%3av1", verse)
      + run("meta%3av", verse)
      + run(PLAIN, body)
      + run("meta%3av", verse),
  )
}

/** A verse whose closing `meta:v` bookend is missing, so it runs on. */
export function openVerse(self: string, verse: string, body: string, chapter?: string): string {
  return paragraph(
    self,
    "cv%3ap",
    (chapter ? run("cv%3adc", chapter) : "")
      + run("cv%3av1", verse)
      + run("meta%3av", verse)
      + run(PLAIN, body),
  )
}

/** The remainder of a run-on verse, closed by its trailing bookend. */
export function verseContinuation(self: string, verse: string, body: string): string {
  return paragraph(self, "cv%3ap", run(PLAIN, body) + run("meta%3av", verse))
}

export function note(self: string, body: string, style = "intro%3aip"): string {
  return paragraph(self, style, run(PLAIN, body))
}

/**
 * One note paragraph whose lines are separated by `<Br/>` — how Biblica sets a
 * cross-reference list, a glossary, or an outline.
 */
export function noteList(
  self: string,
  lines: readonly string[],
  style = "intro%3aili1",
): string {
  return paragraph(
    self,
    style,
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
      + lines.map((line) => `<Content>${line}</Content>`).join("<Br/>")
      + `</CharacterStyleRange>`,
  )
}

/**
 * A multi-sentence note block, the shape of a real study note on a passage.
 * Each sentence is long enough to earn its own cell, and the second starts
 * inside the same paragraph run — the split IDML itself cannot express.
 */
const NOTE_BLOCK_SENTENCES = [
  "2:4\u20137 The garden account retells the creation of humanity from ground level. ",
  "The man is formed from the dust before any rain has fallen on the land. ",
  "Eden is planted for him, and the river that waters it flows out to the wider world.",
] as const

export const SAMPLE_NOTES = {
  preface: "Genesis introduces the story of beginnings.",
  afterChapterOne: "1:1 God alone creates; the heavens and the earth are not rivals.",
  afterChaptersTwoToThree: "2:5 The garden is planted before there is anyone to till it.",
  psalmHeading: "Psalm 2",
  psalmNote: "The nations rage, but the LORD reigns.",
  /** A cross-reference list set as one paragraph with line breaks between items. */
  referenceList: [
    "Luke: Luke 1:1\u20134.",
    "Theophilus: Luke 1:1\u20134.",
    "Gospel: Matthew 1:1\u201317.",
  ],
  noteBlockSentences: NOTE_BLOCK_SENTENCES,
  noteBlock: NOTE_BLOCK_SENTENCES.join(""),
} as const

/**
 * A book whose notes exercise every label case: a preface before any verse, a
 * single-chapter range, a multi-chapter range, a chapter-label heading, a
 * line-broken reference list, and a multi-sentence note block.
 */
export const biblicaSampleStory: readonly string[] = [
  paragraph("p-bk", "meta%3abk", run(PLAIN, "GEN")),
  note("p-pref", SAMPLE_NOTES.preface),
  closedVerse("p-v1", "1", "In the beginning God created the heavens and the earth.", "1"),
  note("p-n1", SAMPLE_NOTES.afterChapterOne, "intro%3aipi"),
  openVerse("p-v2", "5", "No shrub had yet appeared,", "2"),
  verseContinuation("p-v2b", "5", " and no one was working the ground."),
  closedVerse("p-v3", "6", "But streams came up from the earth."),
  closedVerse("p-v4", "1", "Now the serpent was more crafty than any other.", "3"),
  note("p-n2", SAMPLE_NOTES.afterChaptersTwoToThree, "intro%3aipi"),
  // Running header: not scripture, not a note.
  paragraph("p-rh", "meta%3arh", run(PLAIN, "GENESIS 2")),
  paragraph("p-cl", "intro%3ahead%3acl", run(PLAIN, SAMPLE_NOTES.psalmHeading)),
  note("p-n3", SAMPLE_NOTES.psalmNote, "intro%3ad_h"),
  noteList("p-n4", SAMPLE_NOTES.referenceList),
  note("p-n5", SAMPLE_NOTES.noteBlock),
]

/** A paragraph of ordinary layout text — the styles front and back matter use. */
export function layoutParagraph(self: string, text: string, style = "text%3am"): string {
  return paragraph(self, style, run(PLAIN, text))
}

/**
 * A dictionary entry whose lead word carries an InDesign "source serif"
 * apostrophe run. In a note that run is structural glue around the markers; in
 * prose it is an ordinary possessive and has to survive into the cell.
 */
export function apostropheParagraph(
  self: string,
  before: string,
  after: string,
  style = "text%3am",
): string {
  return paragraph(
    self,
    style,
    run(PLAIN, before) + run("source serif", "ʼ") + run(PLAIN, after),
  )
}

export const SAMPLE_FRONT_MATTER = {
  title: "Bible Dictionary",
  /** A table of contents set as one paragraph with a line break per entry. */
  contents: [
    "A — 1",
    "B — 42",
    "How to use this dictionary — 88",
  ],
  runningHead: "BIBLE DICTIONARY 12",
  letterA: "A",
  aaronBefore: "Aaron: Moses",
  aaronAfter: "s brother, and the first high priest of Israel.",
  letterB: "B",
  babel: "Babel: the city whose unfinished tower scattered the nations.",
  usageHeading: "How to use this dictionary",
  usageBody: "Entries are listed alphabetically under the letter they begin with.",
} as const

/** The "Aaron" entry as it reads once its apostrophe run is back inside the word. */
export const SAMPLE_FRONT_MATTER_AARON =
  `${SAMPLE_FRONT_MATTER.aaronBefore}ʼ${SAMPLE_FRONT_MATTER.aaronAfter}`

/**
 * A front/back-matter volume: no chapter or verse is marked anywhere, the text
 * sits in layout styles rather than `intro:*` note styles, a running head repeats
 * page furniture, and the volume's own headings divide it into sections.
 */
export const biblicaFrontMatterStory: readonly string[] = [
  layoutParagraph("f-title", SAMPLE_FRONT_MATTER.title, "title%3amt1"),
  noteList("f-toc", SAMPLE_FRONT_MATTER.contents, "toc%3a1"),
  paragraph("f-rh", "meta%3arh", run(PLAIN, SAMPLE_FRONT_MATTER.runningHead)),
  layoutParagraph("f-a", SAMPLE_FRONT_MATTER.letterA, "head%3ams1"),
  apostropheParagraph(
    "f-aaron",
    SAMPLE_FRONT_MATTER.aaronBefore,
    SAMPLE_FRONT_MATTER.aaronAfter,
  ),
  layoutParagraph("f-b", SAMPLE_FRONT_MATTER.letterB, "head%3ams1"),
  layoutParagraph("f-babel", SAMPLE_FRONT_MATTER.babel),
  layoutParagraph("f-usage", SAMPLE_FRONT_MATTER.usageHeading, "intro%3aimt2"),
  layoutParagraph("f-usage-body", SAMPLE_FRONT_MATTER.usageBody),
]

export function makeBiblicaIdml(
  paragraphs: readonly string[] = biblicaSampleStory,
): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}"><idPkg:Story src="${BIBLICA_STORY_PATH}"/></Document>`,
  )
  zip.file(
    BIBLICA_STORY_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="u1">`
      + paragraphs.join("")
      + `</Story></idPkg:Story>`,
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}
