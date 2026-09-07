import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const BODY_STORY_PATH = "Stories/Story_ebl_body.xml"
const BADGE_STORY_PATH = "Stories/Story_ebl_badge.xml"

const COVER_LINE = "Equipping Biblical Leaders"
/** One InDesign paragraph set over two lines — the guide's title page. */
const TITLE_LINES = ["Facilitator Guide", "Module 1"] as const
const INTRO_HEAD = "INTRODUCTION"
const INTRO_BODY = "The church is seeing remarkable growth in the spread of the Gospel."
const MODULE_LINES = ["MODULE 1", "How we have the Bible"] as const
const TOPIC_TAG = "TOPIC 1.1"
const TOPIC_TITLE = "How God shows himself"
/** One InDesign paragraph, its items separated by line breaks. */
const MATERIALS_HEAD = "Materials needed"
const MATERIALS_LIST = ["Bibles", "Notebooks", "Pens"] as const
const LESSON_TAG = "Lesson 1"
const LESSON_TITLE = "Seeing God from a distance"
/** One InDesign paragraph holding several sentences of facilitator copy. */
const LESSON_SENTENCES = [
  "God has revealed who he is to people since the beginning of the world. ",
  "And God still wants people to know him today.",
] as const
const LESSON_BLOCK = LESSON_SENTENCES.join("")
const GLOSSARY_HEAD = "Words you need to know list"
const GLOSSARY_BODY = "Divine revelation is how God lets us get to know him."
/**
 * A lesson's timing badge sits in a detached frame of its own, set in the same
 * level-1 style a lesson tag uses, and `designmap.xml` lists it ahead of the
 * body. A reader that trusted level-1 headings alone would open the guide on a
 * section called "30 min".
 */
const TIMING_BADGE = "30 min"
/** Page furniture: an InDesign auto-page-number marker, no words of its own. */
const PAGE_NUMBER = "<?ACE 18?>"

const PLAIN = "$ID/[No character style]"

/** InDesign encodes the `:` that nests a style inside its group. */
function paragraph(self: string, paragraphStyle: string, inner: string): string {
  const applied = `ParagraphStyle/${paragraphStyle.replace(/:/g, "%3a")}`
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="${applied}">`
    + inner
    + `</ParagraphStyleRange>`
}

function styled(self: string, paragraphStyle: string, text: string): string {
  return paragraph(
    self,
    paragraphStyle,
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
      + `<Content>${text}</Content></CharacterStyleRange>`,
  )
}

function lineList(
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

function story(self: string, paragraphs: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<idPkg:Story ${IDPKG}><Story Self="${self}">`
    + paragraphs.join("")
    + `</Story></idPkg:Story>`
}

/**
 * An EBL module guide: a cover line above the title page, front matter, a
 * module opener, a topic and its lesson, and a back-matter glossary — plus the
 * detached badge frame the real package lists before the body.
 */
async function writeEblFixture(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}>`
      + `<idPkg:Story src="${BADGE_STORY_PATH}"/>`
      + `<idPkg:Story src="${BODY_STORY_PATH}"/>`
      + `</Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    BADGE_STORY_PATH,
    story("u-badge", [styled("d-badge", "07_Lessons:ms1", TIMING_BADGE)]),
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    BODY_STORY_PATH,
    story("u-body", [
      styled("b-cover", "$ID/[No paragraph style]", COVER_LINE),
      lineList("b-title", "01_Intro page:ms1", TITLE_LINES),
      styled("b-intro-h", "01_Intro page:ms1", INTRO_HEAD),
      styled("b-intro", "01_Intro page:m", INTRO_BODY),
      lineList("b-module", "05_Modules:ms1", MODULE_LINES),
      styled("b-topic-tag", "06_Lesson Intro:ms3", TOPIC_TAG),
      styled("b-topic-title", "06_Lesson Intro:ms1", TOPIC_TITLE),
      styled("b-materials-h", "06_Lesson Intro:ms2_shade ", MATERIALS_HEAD),
      lineList("b-materials", "06_Lesson Intro:li1-shade", MATERIALS_LIST),
      styled("b-l1-tag", "07_Lessons:ms1", LESSON_TAG),
      styled("b-l1-title", "07_Lessons:ms2", LESSON_TITLE),
      styled("b-l1-block", "07_Lessons:m", LESSON_BLOCK),
      styled("b-glossary-h", "07_Lessons:ms1", GLOSSARY_HEAD),
      styled("b-glossary", "07_Lessons:m", GLOSSARY_BODY),
      styled("b-page", "*Page number", PAGE_NUMBER),
    ]),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

test("EBL import brings in the whole guide, divided by its own headings", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukEng_MODULE 1_EBL_FACILITATOR GUIDE.idml")
  await writeEblFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EBL ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture, async (dialog) => {
    // EBL is a fourth InDesign template, so the importer only reads it that way
    // when this is ticked. It is off by default.
    const ebl = dialog.getByRole("checkbox", { name: /This is an EBL file/i })
    await expect(ebl).not.toBeChecked()

    // The three titles are alternatives, so ticking EBL clears whichever was
    // already ticked.
    const treasureHunt = dialog.getByRole("checkbox", {
      name: /This is a Treasure Hunt Bible file/i,
    })
    await treasureHunt.click()
    await expect(treasureHunt).toBeChecked()
    await ebl.click()
    await expect(ebl).toBeChecked()
    await expect(treasureHunt).not.toBeChecked()
    await expect(dialog.getByRole("checkbox", {
      name: /This is a Reach 4 Life file/i,
    })).not.toBeChecked()

    // Sentence splitting is not a title, so it sits outside that group and
    // stays independent of it.
    const split = dialog.getByRole("checkbox", {
      name: /Split long notes into one cell per sentence/i,
    })
    await split.click()
    await expect(split).toBeChecked()
    await expect(ebl).toBeChecked()
  })

  await ws.openFileBySubstring("EBL_FACILITATOR")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(20, { timeout: 15_000 })

  // A guide is written material throughout, so unlike the study-Bible readings
  // every text-bearing paragraph is imported — starting with the loose badge
  // frame InDesign threads ahead of the body.
  await expect(ws.cellRow(0)).toContainText(TIMING_BADGE)
  await expect(ws.cellRow(1)).toContainText(COVER_LINE)

  // A heading set over two lines is two cells, because a translator works a
  // line at a time — but it is still one heading.
  await expect(ws.cellRow(2)).toContainText(TITLE_LINES[0])
  await expect(ws.cellRow(3)).toContainText(TITLE_LINES[1])

  // A materials list is one InDesign paragraph and always arrives per line,
  // whether or not sentence splitting is on.
  await expect(ws.cellRow(10)).toContainText(MATERIALS_HEAD)
  await expect(ws.cellRow(11)).toContainText(MATERIALS_LIST[0])
  await expect(ws.cellRow(11)).not.toContainText(MATERIALS_LIST[1])
  await expect(ws.cellRow(12)).toContainText(MATERIALS_LIST[1])
  await expect(ws.cellRow(13)).toContainText(MATERIALS_LIST[2])

  // With the split option ticked, a teaching block arrives as one cell per
  // sentence; export merges the sentences back into that paragraph.
  await expect(ws.cellRow(16)).toContainText(LESSON_SENTENCES[0].trim())
  await expect(ws.cellRow(16)).not.toContainText(LESSON_SENTENCES[1])
  await expect(ws.cellRow(17)).toContainText(LESSON_SENTENCES[1])

  // Page furniture holds no words, so it owns no cell.
  await expect(alice.getByText(PAGE_NUMBER)).toHaveCount(0)

  // The guide's own headings become its sections, so the navigator moves a
  // topic or a lesson at a time. The badge is a pull-out box, not a heading —
  // it opens the file's box section rather than a section called "30 min".
  await expect(alice.getByRole("combobox", {
    name: /Current section: Boxes and tables/,
  })).toBeVisible()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${TIMING_BADGE}`),
  })).toHaveCount(0)

  // The cover line is printed above the title page and has no heading of its
  // own, so it belongs to the section it introduces rather than to the boxes
  // that happen to precede it in the InDesign thread.
  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${TITLE_LINES.join(" ")}`),
  })).toBeVisible()

  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${INTRO_HEAD}`),
  })).toBeVisible()

  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${MODULE_LINES.join(" ")}`),
  })).toBeVisible()

  // A topic opens on its numbered tag, and the level-1 heading under the tag is
  // the topic's title rather than a second section.
  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: Topic 1.1: ${TOPIC_TITLE}`),
  })).toBeVisible()

  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${LESSON_TAG}: ${LESSON_TITLE}`),
  })).toBeVisible()

  // A level-1 heading in the lesson group that numbers no lesson is back
  // matter, so it gets a section of its own.
  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current section: ${GLOSSARY_HEAD}`),
  })).toBeVisible()
  await expect(alice.getByRole("button", { name: "Next section" })).toBeDisabled()

  // Each Biblica edition lands in a folder of its own, so one project can hold
  // all four without their files mixing in the sidebar.
  await expect(
    alice.getByRole("button", { name: "Collapse Equipping Biblical Leaders" }),
  ).toBeVisible()

  // Guide copy stays editable as a normal target cell, with its InDesign
  // formatting locked.
  await ws.editCell(1, "Équiper les responsables bibliques")
  await expect(ws.cellRow(1)).toContainText("Équiper les responsables bibliques")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})

test("EBL file imported without the toggle explains what to tick", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukEng_MODULE 1_EBL_PARTICIPANT GUIDE.idml")
  await writeEblFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EBL untoggled ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  const dialog = await ws.attemptImportViaSpecializedPanel(
    /Biblica Study Bible Notes/i,
    fixture,
  )

  // A guide has no `intro:*` paragraphs, so the study-Bible reading finds
  // nothing — the error has to name the toggle that fixes it.
  await expect(dialog.getByText(/contained no study notes/i)).toBeVisible()
  await expect(dialog.getByText(/This is an EBL file/i).first()).toBeVisible()
})
