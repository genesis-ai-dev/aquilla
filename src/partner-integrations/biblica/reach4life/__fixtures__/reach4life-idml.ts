/**
 * Minimal Reach4Life IDML packages for tests.
 *
 * The shapes mirror the two InDesign templates a Reach4Life edition ships in.
 * The scripture volumes group styles typographically — `Paragraphs:Regular
 * paragraphs:p`, `Poetry:q1`, `Headings:s1` and `Titles:mt1` for the published
 * NIrV, `Metatext_BBI Bible Book Intros:*` for the per-book introductions,
 * `Intros:*` / `Copyright:*` / `Additional:*` for front and back matter, and
 * `Page Elements:*` for running heads and TOC markers. The workbook sections put
 * everything under `R4Lv4 Paragraph Styles:` and a numbered group per feature.
 *
 * Style names are written the way InDesign stores them, with the group
 * separator URL-encoded as `%3a`, so the fixtures exercise the decoding the
 * rules do rather than assuming a pre-decoded name.
 */

import JSZip from "jszip"

const MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

export const REACH4LIFE_STORY_PATH = "Stories/Story_u1.xml"

const PLAIN = "$ID/[No character style]"

/** One `<CharacterStyleRange>` holding one `<Content>` run per text argument. */
export function run(characterStyle: string, ...texts: string[]): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${characterStyle}">`
    + texts.map((text) => `<Content>${text}</Content>`).join("")
    + `</CharacterStyleRange>`
}

/** InDesign encodes the `:` that nests a style inside its group. */
function encodeStyleName(styleName: string): string {
  return styleName.replace(/:/g, "%3a")
}

export function paragraph(self: string, paragraphStyle: string, inner: string): string {
  const applied = `ParagraphStyle/${encodeStyleName(paragraphStyle)}`
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="${applied}">`
    + inner
    + `</ParagraphStyleRange>`
}

/** A plain single-run paragraph in `paragraphStyle`. */
export function styled(self: string, paragraphStyle: string, text: string): string {
  return paragraph(self, paragraphStyle, run(PLAIN, text))
}

/**
 * One paragraph whose lines are separated by `<Br/>` — how both templates set a
 * contents block, a list of journey steps, or a run of bullet advice.
 */
export function lineList(
  self: string,
  paragraphStyle: string,
  lines: readonly string[],
): string {
  return paragraph(
    self,
    paragraphStyle,
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
      + lines.map((line) => `<Content>${line}</Content>`).join("<Br/>")
      + `</CharacterStyleRange>`,
  )
}

/** A scripture paragraph with its chapter drop cap and verse number runs. */
export function scripture(
  self: string,
  body: string,
  options: { chapter?: string; verse?: string; style?: string } = {},
): string {
  const style = options.style
    ?? (options.chapter
      ? "Paragraphs:Regular paragraphs:p-chpt1"
      : "Paragraphs:Regular paragraphs:p")
  return paragraph(
    self,
    style,
    (options.chapter ? run("cChapterNumber", options.chapter) : "")
      + (options.verse ? run("cVerse", options.verse) : "")
      + run(PLAIN, body),
  )
}

/**
 * A multi-sentence lesson block, the shape of real Reach4Life teaching copy.
 * Each sentence is long enough to earn its own cell, and the second starts
 * inside the same paragraph run — the split IDML itself cannot express.
 */
const LESSON_BLOCK_SENTENCES = [
  "When you look at yourself in the mirror, what do you see? ",
  "Do you sometimes feel your family does not know the real you? ",
  "There is a much better way to find out who you are: ask the one who made you.",
] as const

export const SAMPLE_REACH4LIFE = {
  bookStrapline: "Stories about Jesus",
  bookTitle: "Matthew",
  bookIntroHead: "Who was Matthew?",
  bookIntroBody: "Matthew was one of Jesus\u2019 disciples. He collected taxes before Jesus called him.",
  secondBookTitle: "Mark",
  secondBookIntroHead: "Who was Mark?",
  scriptureHead: "The family line of Jesus the Messiah",
  scriptureBody: "This is the written story of the family line of Jesus the Messiah.",
  scriptureVerse: "A ruler will come out of you.",
  copyright: "Holy Bible, New International Reader\u2019s Version copyright 1995, 1996, 1998, 2014 by Biblica, Inc.",
  contentsEntries: ["Matthew 1", "Mark 41", "Luke 66"],
  readingGuideHead: "Where to start",
  readingGuide: "Here are some ideas of where to start in the New Testament.",
  lessonTitle: "Who am I?",
  lessonBlockSentences: LESSON_BLOCK_SENTENCES,
  lessonBlock: LESSON_BLOCK_SENTENCES.join(""),
  lessonQuote: "So God created human beings in his own likeness. He created them to be like himself.",
  lessonQuoteRef: "Genesis 1:27",
  storyTitle: "The story",
  storyBody: "He is real. He is alive and well, ablaze with energy.",
  psalmHeading: "Psalm 1 (see Live lesson 3 on Rpg 92)",
  psalmSuperscription: "For the director of music. A psalm of David.",
  psalmLine: "Blessed is the person who obeys the law of the Lord.",
  runningHead: "Who am I? | ",
  productionNote: "TRANSLATED LANGUAGE NOTE: Add translation of R4L title underneath the Red R4L Logo",
} as const

/**
 * A scripture volume: two book introductions (each opened by a strapline set
 * above its title), the published text that must not be imported, front matter,
 * a line-broken contents block, and page furniture.
 */
export const reach4LifeScriptureSampleStory: readonly string[] = [
  styled("p-strap", "Metatext_BBI Bible Book Intros:cl", SAMPLE_REACH4LIFE.bookStrapline),
  styled("p-imt1", "Metatext_BBI Bible Book Intros:imt1", SAMPLE_REACH4LIFE.bookTitle),
  styled("p-is1", "Metatext_BBI Bible Book Intros:is1", SAMPLE_REACH4LIFE.bookIntroHead),
  styled("p-im", "Metatext_BBI Bible Book Intros:im", SAMPLE_REACH4LIFE.bookIntroBody),
  styled("p-strap2", "Metatext_BBI Bible Book Intros:cl", SAMPLE_REACH4LIFE.bookStrapline),
  styled("p-imt1b", "Metatext_BBI Bible Book Intros:imt1", SAMPLE_REACH4LIFE.secondBookTitle),
  styled("p-is1b", "Metatext_BBI Bible Book Intros:is1", SAMPLE_REACH4LIFE.secondBookIntroHead),
  // Scripture: the title, the section heading, the prose and the poetry are all
  // set from the publisher's files.
  styled("p-mt1", "Titles:mt1", SAMPLE_REACH4LIFE.bookTitle),
  styled("p-s1", "Headings:s1", SAMPLE_REACH4LIFE.scriptureHead),
  scripture("p-v1", SAMPLE_REACH4LIFE.scriptureBody, { chapter: "1", verse: "1" }),
  styled("p-q1", "Poetry:q1", SAMPLE_REACH4LIFE.scriptureVerse),
  styled("p-copy", "Copyright:pc", SAMPLE_REACH4LIFE.copyright),
  lineList("p-toc", "Additional:TOC Entry", SAMPLE_REACH4LIFE.contentsEntries),
  styled("p-guide-h", "Intros:is1", SAMPLE_REACH4LIFE.readingGuideHead),
  styled("p-guide", "Intros:im", SAMPLE_REACH4LIFE.readingGuide),
  // Page furniture: never a cell, whatever it holds.
  styled("p-rh", "Page Elements:h", SAMPLE_REACH4LIFE.bookTitle),
  styled("p-toc1", "Page Elements:toc1", SAMPLE_REACH4LIFE.bookTitle),
  styled("p-pn", "Page Elements:rem", "<?ACE 18?>"),
]

/**
 * A workbook section: a lesson with a multi-sentence block and an inline
 * scripture pull-quote, a story section, the Psalms reading whose poetry and
 * superscription are scripture but whose Reach4Life heading is not, and the
 * page furniture and typesetter note that are neither.
 */
export const reach4LifeWorkbookSampleStory: readonly string[] = [
  styled("w-rh", "R4Lv4 Paragraph Styles:0_Page elements:rh1", SAMPLE_REACH4LIFE.runningHead),
  styled("w-note", "R4Lv4 Paragraph Styles:#NB PINK to check", SAMPLE_REACH4LIFE.productionNote),
  styled("w-ms1", "R4Lv4 Paragraph Styles:4_WAI:ms1", SAMPLE_REACH4LIFE.lessonTitle),
  styled("w-m", "R4Lv4 Paragraph Styles:4_WAI:m", SAMPLE_REACH4LIFE.lessonBlock),
  styled("w-q1", "R4Lv4 Paragraph Styles:4_WAI:q1", SAMPLE_REACH4LIFE.lessonQuote),
  styled("w-qr", "R4Lv4 Paragraph Styles:4_WAI:qr", SAMPLE_REACH4LIFE.lessonQuoteRef),
  styled("w-story-ms1", "R4Lv4 Paragraph Styles:5_Story:ms1", SAMPLE_REACH4LIFE.storyTitle),
  styled("w-story-m", "R4Lv4 Paragraph Styles:5_Story:m", SAMPLE_REACH4LIFE.storyBody),
  styled("w-psalm-cl", "R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:cl", SAMPLE_REACH4LIFE.psalmHeading),
  styled("w-psalm-d", "R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:d-h", SAMPLE_REACH4LIFE.psalmSuperscription),
  styled("w-psalm-q", "R4Lv4 Paragraph Styles:7_Psalms:Poetry:q1", SAMPLE_REACH4LIFE.psalmLine),
]

export function makeReach4LifeIdml(
  paragraphs: readonly string[] = reach4LifeScriptureSampleStory,
): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}"><idPkg:Story src="${REACH4LIFE_STORY_PATH}"/></Document>`,
  )
  zip.file(
    REACH4LIFE_STORY_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="u1">`
      + paragraphs.join("")
      + `</Story></idPkg:Story>`,
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}
