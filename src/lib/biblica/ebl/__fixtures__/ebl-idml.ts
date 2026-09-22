/**
 * A minimal Equipping Biblical Leaders IDML package for tests.
 *
 * The shape mirrors a real module guide: one long threaded story carrying the
 * whole guide — cover line, front matter, a module opener, a topic opener and
 * its lessons, back matter — plus the detached single-frame stories InDesign
 * keeps a guide's pull-out boxes in, listed ahead of the body the way the real
 * package's `designmap.xml` lists them.
 *
 * That ordering is the point of the fixture: the "30 min" badge is set in the
 * same level-1 style a lesson tag uses, so a reader that took every level-1
 * heading at face value would open the file with a division called "30 min".
 *
 * Style names are written the way InDesign stores them, with the group
 * separator URL-encoded as `%3a`, so the fixtures exercise the decoding the
 * rules do rather than assuming a pre-decoded name.
 */

import JSZip from "jszip"

const MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

const PLAIN = "$ID/[No character style]"

export const EBL_BODY_STORY_PATH = "Stories/Story_ubody.xml"
export const EBL_BADGE_STORY_PATH = "Stories/Story_ubadge.xml"
export const EBL_SUMMARY_STORY_PATH = "Stories/Story_usummary.xml"

/** InDesign encodes the `:` that nests a style inside its group. */
function encodeStyleName(styleName: string): string {
  return styleName.replace(/:/g, "%3a")
}

function paragraph(self: string, paragraphStyle: string, inner: string): string {
  const applied = `ParagraphStyle/${encodeStyleName(paragraphStyle)}`
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="${applied}">`
    + inner
    + `</ParagraphStyleRange>`
}

/** A plain single-run paragraph in `paragraphStyle`. */
export function styled(self: string, paragraphStyle: string, text: string): string {
  return paragraph(
    self,
    paragraphStyle,
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
      + `<Content>${text}</Content>`
      + `</CharacterStyleRange>`,
  )
}

/**
 * Contents entries the way the live template writes the top-level lines: the
 * title in one character run, the page number in the next, a `<Br/>` after.
 */
export function tocEntriesWithPageRuns(
  self: string,
  paragraphStyle: string,
  entries: readonly { title: string; page: string }[],
): string {
  return paragraph(
    self,
    paragraphStyle,
    entries.map((entry) => (
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
        + `<Content>${entry.title}</Content>`
        + `</CharacterStyleRange>`
        + `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}" PointSize="16">`
        + `<Content>${entry.page}</Content>`
        + `</CharacterStyleRange>`
        + `<Br />`
    )).join(""),
  )
}

/**
 * One paragraph whose lines are separated by `<Br/>` — how the template sets a
 * contents block, a list of objectives, and a heading run over two lines.
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

/**
 * A multi-sentence teaching block, the shape of real facilitator copy: each
 * sentence earns its own cell, and the split is one IDML itself cannot express.
 */
const LESSON_BLOCK_SENTENCES = [
  "God has revealed who he is to people since the beginning of the world. ",
  "He walked with Adam and Eve in the garden and he spoke to Moses on the mountain. ",
  "And God still wants people to know him today.",
] as const

export const SAMPLE_EBL = {
  coverLine: "Equipping Biblical Leaders",
  titleLines: ["Facilitator Guide", "Module 1"],
  introHead: "INTRODUCTION",
  introBody: "The church is seeing remarkable growth in the spread of the Gospel.",
  contentsHead: "CONTENTS",
  contentsEntries: ["Introduction 3", "About the programme 4", "Module 1 16"],
  /** Titles whose page numbers live in a neighbouring character run. */
  contentsTitles: [
    "Introduction",
    "About the programme",
    "Module 1: How we have the Bible",
  ],
  contentsPages: ["3", "4", "16"],
  /** A nested contents line: title and page number share one Content run. */
  contentsNestedTitle: "1.1 How God shows himself",
  contentsNestedPage: "18",
  contentsNestedEntry: "1.1 How God shows himself\t\t\t18",
  moduleLines: ["MODULE 1", "How we have the Bible"],
  moduleBody: "This module looks at where the Bible came from.",
  topicTag: "TOPIC 1.1",
  topicTitle: "How God shows himself",
  topicBody: "God makes himself known in different ways.",
  materialsHead: "Materials needed",
  materialsList: ["Bibles", "Notebooks", "Pens"],
  lessonOneTag: "Lesson 1",
  lessonOneTitle: "Seeing God from a distance",
  lessonBlockSentences: LESSON_BLOCK_SENTENCES,
  lessonBlock: LESSON_BLOCK_SENTENCES.join(""),
  bibleStudyHead: "Bible study",
  bibleStudyBody: "Read Psalm 19:1-4 together as a group.",
  lessonTwoTag: "Lesson 2",
  lessonTwoTitle: "Seeing God up close",
  lessonTwoBody: "Jesus is the clearest picture we have of God.",
  glossaryHead: "Words you need to know list",
  glossaryBody: "Divine revelation is the process by which God lets us get to know him.",
  timingBadge: "30 min",
  summaryBanner: "TOPIC SUMMARY",
  pageNumber: "<?ACE 18?>",
  /** A matching-exercise table's row number — not a sentence. */
  tableNumber: "8",
  /** A write-in rule drawn as punctuation, not words. */
  writeInRule: "-------------------",
  writeInPrompt: "Write one thing you learned.",
} as const

/** The guide itself: one threaded story, in reading order. */
export const eblBodyStory: readonly string[] = [
  // Set in an unnamed default, and printed above the first heading — so it has
  // no division of its own and belongs with the title page it introduces.
  styled("b-cover", "$ID/[No paragraph style]", SAMPLE_EBL.coverLine),
  lineList("b-title", "01_Intro page:ms1", SAMPLE_EBL.titleLines),
  styled("b-intro-h", "01_Intro page:ms1", SAMPLE_EBL.introHead),
  styled("b-intro", "01_Intro page:m", SAMPLE_EBL.introBody),
  styled("b-toc-h", "02_TOC:ms1", SAMPLE_EBL.contentsHead),
  lineList("b-toc", "02_TOC:tc1", SAMPLE_EBL.contentsEntries),
  lineList("b-module", "05_Modules:ms1", SAMPLE_EBL.moduleLines),
  styled("b-module-body", "05_Modules:m", SAMPLE_EBL.moduleBody),
  // A topic opens on its numbered tag; the level-1 heading under it is the
  // title, not a second division.
  styled("b-topic-tag", "06_Lesson Intro:ms3", SAMPLE_EBL.topicTag),
  styled("b-topic-title", "06_Lesson Intro:ms1", SAMPLE_EBL.topicTitle),
  styled("b-topic-body", "06_Lesson Intro:p", SAMPLE_EBL.topicBody),
  // A decorated level-2 heading, with a trailing space in the style name as the
  // template writes it. Inside the topic, never opening one.
  styled("b-materials-h", "06_Lesson Intro:ms2_shade ", SAMPLE_EBL.materialsHead),
  lineList("b-materials", "06_Lesson Intro:li1-shade", SAMPLE_EBL.materialsList),
  styled("b-l1-tag", "07_Lessons:ms1", SAMPLE_EBL.lessonOneTag),
  styled("b-l1-title", "07_Lessons:ms2", SAMPLE_EBL.lessonOneTitle),
  styled("b-l1-block", "07_Lessons:m", SAMPLE_EBL.lessonBlock),
  styled("b-l1-study-h", "07_Lessons:ms5", SAMPLE_EBL.bibleStudyHead),
  styled("b-l1-study", "07_Lessons:m_shade1", SAMPLE_EBL.bibleStudyBody),
  styled("b-l2-tag", "07_Lessons:ms1", SAMPLE_EBL.lessonTwoTag),
  styled("b-l2-title", "07_Lessons:ms2", SAMPLE_EBL.lessonTwoTitle),
  styled("b-l2-body", "07_Lessons:p", SAMPLE_EBL.lessonTwoBody),
  // A matching table's own numbers, and a ruled write-in line: both look like
  // cells but have nothing a translator can say.
  styled("b-table-no", "07_Lessons:table no", SAMPLE_EBL.tableNumber),
  styled("b-rule", "07_Lessons:m_indent sb", SAMPLE_EBL.writeInRule),
  lineList("b-write-in", "07_Lessons:m_indent sb", [
    SAMPLE_EBL.writeInPrompt,
    SAMPLE_EBL.writeInRule,
  ]),
  // Back matter: a level-1 heading in the lesson group that numbers no lesson.
  styled("b-glossary-h", "07_Lessons:ms1", SAMPLE_EBL.glossaryHead),
  styled("b-glossary", "07_Lessons:m", SAMPLE_EBL.glossaryBody),
  styled("b-page", "*Page number", SAMPLE_EBL.pageNumber),
]

/** A lesson's timing badge: a level-1 heading, and the whole frame. */
export const eblBadgeStory: readonly string[] = [
  styled("d-badge", "07_Lessons:ms1", SAMPLE_EBL.timingBadge),
]

/** A topic summary banner, in a frame of its own. */
export const eblSummaryStory: readonly string[] = [
  styled("s-banner", "07_Lessons:test summary header", SAMPLE_EBL.summaryBanner),
]

export interface EblIdmlStories {
  body?: readonly string[]
  badge?: readonly string[]
  summary?: readonly string[]
}

/**
 * Build the package. The two loose frames are listed ahead of the body, which
 * is the order the real guide's `designmap.xml` uses and the order the engine
 * therefore reports its units in.
 */
export function makeEblIdml(stories: EblIdmlStories = {}): Promise<ArrayBuffer> {
  const members: [string, string, readonly string[]][] = []
  const badge = stories.badge ?? eblBadgeStory
  const summary = stories.summary ?? eblSummaryStory
  const body = stories.body ?? eblBodyStory
  if (summary.length > 0) members.push(["usummary", EBL_SUMMARY_STORY_PATH, summary])
  if (badge.length > 0) members.push(["ubadge", EBL_BADGE_STORY_PATH, badge])
  if (body.length > 0) members.push(["ubody", EBL_BODY_STORY_PATH, body])

  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}">`
      + members.map(([, path]) => `<idPkg:Story src="${path}"/>`).join("")
      + `</Document>`,
  )
  for (const [self, path, paragraphs] of members) {
    zip.file(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>`
        + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="${self}">`
        + paragraphs.join("")
        + `</Story></idPkg:Story>`,
    )
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}
