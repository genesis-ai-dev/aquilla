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
} as const

/**
 * A book whose notes exercise every label case: a preface before any verse, a
 * single-chapter range, a multi-chapter range, a chapter-label heading, and a
 * line-broken reference list.
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
