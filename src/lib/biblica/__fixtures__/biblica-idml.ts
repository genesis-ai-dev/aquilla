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
 * A note whose paragraph ends with the closing `meta:v` bookend of the verse
 * that came before it — InDesign flushes those markers into the next paragraph
 * of the text flow, so they surface inside the notes.
 */
export function noteWithTrailingVerseMarker(
  self: string,
  body: string,
  verse: string,
  style = "intro%3aipi",
): string {
  return paragraph(self, style, run(PLAIN, body) + run("meta%3av", verse))
}

/**
 * The `intro:ie` paragraph that closes a book: nothing but the previous book's
 * final chapter/verse markers, which is how "28:20" ends up in Mark's preface.
 */
export function verseMarkerOnlyNote(self: string, chapter: string, verse: string): string {
  return paragraph(self, "intro%3aie", run("meta%3ac", `${chapter}:`) + run("meta%3av", verse))
}

/**
 * The `intro:imt2` heading that opens a division — a group of books such as
 * "Israelʼs covenant history". InDesign sets it inside the following book's
 * front matter, and stores the typesetter's soft hyphens in the text itself.
 */
export function divisionHeading(self: string, text: string): string {
  return paragraph(self, "intro%3aimt2", run(PLAIN, text))
}

/** The `intro:imt1` book title that closes a division and opens a preface. */
export function bookTitle(self: string, text: string): string {
  return paragraph(self, "intro%3aimt1", run(PLAIN, text))
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

/**
 * A paragraph of a front/back matter volume: its text sits in a layout style
 * (`text:*`, `toc:*`, `title:*`, `Box Text`) rather than in an `intro:*` note.
 */
export function layoutText(self: string, body: string, style = "text%3am"): string {
  return paragraph(self, style, run(PLAIN, body))
}

/** The `head:ms1` heading that opens a section of a front/back volume. */
export function majorSectionHeading(self: string, text: string): string {
  return paragraph(self, "head%3ams1", run(PLAIN, text))
}

export const FRONT_BACK_MATTER = {
  title: "Bible Dictionary",
  firstLetter: "A",
  firstEntry: "Aaron: Exodus 4:14. Page 89",
  /** Prose whose apostrophe is an ordinary possessive, not structural glue. */
  firstBody: ["Aaron was Moses", "\u02BC", "s brother and the first priest."],
  runningHead: "Bible Dictionary 1701",
  secondLetter: "B",
  secondEntry: "Babel: Genesis 11:1\u20139. Page 24",
} as const

/**
 * A front/back matter volume, in the shape the Bible Dictionary has: a title,
 * a section per alphabet letter, entries and prose in layout styles, and the
 * running heads InDesign regenerates on every page. No book marker and no
 * verse markers anywhere — which is what says it is not a book volume.
 */
export const biblicaFrontBackMatterStory: readonly string[] = [
  paragraph("p-title", "intro%3aimt2", run(PLAIN, FRONT_BACK_MATTER.title)),
  majorSectionHeading("p-a", FRONT_BACK_MATTER.firstLetter),
  layoutText("p-a1", FRONT_BACK_MATTER.firstEntry, "text%3ap"),
  paragraph(
    "p-a2",
    "text%3am",
    run(PLAIN, FRONT_BACK_MATTER.firstBody[0])
      + run("source serif", FRONT_BACK_MATTER.firstBody[1])
      + run(PLAIN, FRONT_BACK_MATTER.firstBody[2]),
  ),
  paragraph("p-rh", "meta%3arh", run(PLAIN, FRONT_BACK_MATTER.runningHead)),
  majorSectionHeading("p-b", FRONT_BACK_MATTER.secondLetter),
  layoutText("p-b1", FRONT_BACK_MATTER.secondEntry, "text%3ap"),
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
