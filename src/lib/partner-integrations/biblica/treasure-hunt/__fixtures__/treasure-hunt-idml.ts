/**
 * Minimal Treasure Hunt Bible IDML packages for tests.
 *
 * The shapes mirror how the real NIrV Treasure Hunt InDesign template marks up a
 * volume: the published Bible text is set in `p*` / `CHAP1p*` paragraph styles
 * with `cVerse` and `cSmChapNum` runs, the Treasure Hunt apparatus lives in
 * `!meta_*` paragraphs opened by a `!meta_fact_head` / `!meta_hunt_head`
 * reference, per-book introductions use `_intro_*`, front matter uses `par*` /
 * `fm_*` / `toc_*`, and running heads and page numbers use `#rh_*` / `#pn`.
 */

import JSZip from "jszip"

const MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

export const TREASURE_HUNT_STORY_PATH = "Stories/Story_u1.xml"

const PLAIN = "$ID/[No character style]"

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

/** A scripture paragraph: chapter drop cap, verse number runs, and the text. */
export function scripture(
  self: string,
  body: string,
  options: { chapter?: string; verse?: string; style?: string } = {},
): string {
  const style = options.style
    ?? (options.chapter ? "CHAP1pNormalAfterSectionHead" : "pNormal")
  return paragraph(
    self,
    style,
    (options.chapter ? run("cChapterKern", options.chapter) : "")
      + (options.verse ? run("cVerse", options.verse) : "")
      + run(PLAIN, body),
  )
}

/** A `pSectionHead` heading, part of the published scripture typesetting. */
export function sectionHead(self: string, text: string): string {
  return paragraph(self, "pSectionHead", run(PLAIN, text))
}

/** A `!meta_fact_head` / `!meta_hunt_head` reference opening a block. */
export function blockHead(self: string, reference: string, hunt = false): string {
  return paragraph(
    self,
    hunt ? "!meta_hunt_head" : "!meta_fact_head",
    run(PLAIN, reference),
  )
}

export function note(self: string, body: string, style = "!meta_par"): string {
  return paragraph(self, style, run(PLAIN, body))
}

/**
 * One paragraph whose lines are separated by `<Br/>` — how the template sets a
 * hunt's steps, a fact's bullets, or a contents list.
 */
export function noteList(
  self: string,
  lines: readonly string[],
  style = "!meta_hunt_list",
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
 * A multi-sentence fact block, the shape of a real Treasure Hunt fact. Each
 * sentence is long enough to earn its own cell, and the second starts inside the
 * same paragraph run — the split IDML itself cannot express.
 */
const FACT_BLOCK_SENTENCES = [
  "To create something means to make something new. ",
  "It means to make something that did not exist before. ",
  "That is exactly what God did when he created the heavens and the earth.",
] as const

export const SAMPLE_TREASURE_HUNT = {
  introSection: "Israel\u2019s covenant history",
  introBook: "Genesis",
  introHead: "What is this book about?",
  introList: [
    "The book has two parts.",
    "Genesis 1 \u2013 11 tells us something about the world in which we live.",
  ],
  factHead: "Genesis 1:1",
  huntHead: "Genesis 3:8\u221210",
  rangeHead: "Genesis 1 \u2013 3",
  huntNote: "Hearty has a question for you. Why did Adam hide from God?",
  huntSteps: [
    "Give some of your toys to a cr\u00e8che.",
    "Ask your friends to bring tinned food to your birthday party.",
  ],
  frontMatterTitle: "Hummy\u2019s orchestra",
  frontMatter: "Copyright \u00a9 2017 by Biblica, Inc. All rights reserved worldwide.",
  scriptureHead: "The Beginning",
  scriptureBody: "In the beginning, God created the heavens and the earth.",
  factBlockSentences: FACT_BLOCK_SENTENCES,
  factBlock: FACT_BLOCK_SENTENCES.join(""),
} as const

/**
 * A volume exercising every case: front matter before any book, a book
 * introduction, scripture that must not be imported, a fact block anchored to a
 * chapter, a hunt block anchored to a verse range, a chapter-range heading, a
 * line-broken hunt list, page furniture, and a multi-sentence fact block.
 */
export const treasureHuntSampleStory: readonly string[] = [
  paragraph("p-fm-title", "fm_title", run(PLAIN, SAMPLE_TREASURE_HUNT.frontMatterTitle)),
  paragraph("p-fm", "par_center", run(PLAIN, SAMPLE_TREASURE_HUNT.frontMatter)),
  paragraph("p-sec", "_intro_section", run(PLAIN, SAMPLE_TREASURE_HUNT.introSection)),
  paragraph("p-book", "_intro_book_long", run(PLAIN, SAMPLE_TREASURE_HUNT.introBook)),
  paragraph("p-ihead", "_intro_head", run(PLAIN, SAMPLE_TREASURE_HUNT.introHead)),
  noteList("p-ilist", SAMPLE_TREASURE_HUNT.introList, "_intro_list_lv1"),
  paragraph("p-title", "pTitleMain", run(PLAIN, "Genesis")),
  sectionHead("p-shead", SAMPLE_TREASURE_HUNT.scriptureHead),
  scripture("p-v1", SAMPLE_TREASURE_HUNT.scriptureBody, { chapter: "1", verse: "1" }),
  blockHead("p-fhead", SAMPLE_TREASURE_HUNT.factHead),
  note("p-fact", SAMPLE_TREASURE_HUNT.factBlock),
  blockHead("p-hhead", SAMPLE_TREASURE_HUNT.huntHead, true),
  note("p-hunt", SAMPLE_TREASURE_HUNT.huntNote, "!meta_par_ns"),
  noteList("p-hsteps", SAMPLE_TREASURE_HUNT.huntSteps),
  blockHead("p-rhead", SAMPLE_TREASURE_HUNT.rangeHead, true),
  note("p-range", "Read these chapters and draw what you find."),
  // Page furniture: never a cell, whatever it holds.
  paragraph("p-rh", "#rh_verso", run(PLAIN, "| GENESIS")),
  paragraph("p-pn", "#pn", run(PLAIN, "<?ACE 18?>")),
  paragraph("p-proof", "zz.proof stages", run(PLAIN, "THB NirvA Firsts")),
]

export function makeTreasureHuntIdml(
  paragraphs: readonly string[] = treasureHuntSampleStory,
): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}"><idPkg:Story src="${TREASURE_HUNT_STORY_PATH}"/></Document>`,
  )
  zip.file(
    TREASURE_HUNT_STORY_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="u1">`
      + paragraphs.join("")
      + `</Story></idPkg:Story>`,
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}
