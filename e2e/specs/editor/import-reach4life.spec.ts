import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_reach4life.xml"

const LESSON_TITLE = "Who am I?"
const LESSON_QUOTE = "So God created human beings in his own likeness."
const LESSON_QUOTE_REF = "Genesis 1:27"
const STORY_TITLE = "The story"
const PSALM_HEADING = "Psalm 1 (see Live lesson 3 on Rpg 92)"
const PSALM_LINE = "Blessed is the person who obeys the law of the Lord."
const PSALM_SUPERSCRIPTION = "For the director of music. A psalm of David."
const RUNNING_HEAD = "Who am I? | "
/** One InDesign paragraph, its items separated by line breaks. */
const STORY_STEPS = [
  "Talk about a time you felt out of place.",
  "Write down one thing you like about yourself.",
] as const
/** One InDesign paragraph holding several sentences of a lesson block. */
const LESSON_SENTENCES = [
  "When you look at yourself in the mirror, what do you see? ",
  "There is a much better way to find out who you are: ask the one who made you.",
] as const
const LESSON_BLOCK = LESSON_SENTENCES.join("")

const PLAIN = "$ID/[No character style]"

function run(characterStyle: string, text: string): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${characterStyle}">`
    + `<Content>${text}</Content></CharacterStyleRange>`
}

/** InDesign encodes the `:` that nests a style inside its group. */
function paragraph(self: string, paragraphStyle: string, inner: string): string {
  const applied = `ParagraphStyle/${paragraphStyle.replace(/:/g, "%3a")}`
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="${applied}">`
    + inner
    + `</ParagraphStyleRange>`
}

/**
 * A Reach 4 Life workbook page: the running head, a lesson whose teaching block
 * is several sentences and whose pull-quote is scripture set inside the lesson,
 * a story section with a line-broken step list, and the Psalms reading — a
 * Reach 4 Life heading above continuous published text.
 */
async function writeReach4LifeFixture(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${STORY_PATH}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    STORY_PATH,
    [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<idPkg:Story ${IDPKG}><Story Self="u400">`,
      paragraph("w-rh", "R4Lv4 Paragraph Styles:0_Page elements:rh1", run(PLAIN, RUNNING_HEAD)),
      paragraph("w-ms1", "R4Lv4 Paragraph Styles:4_WAI:ms1", run(PLAIN, LESSON_TITLE)),
      paragraph("w-m", "R4Lv4 Paragraph Styles:4_WAI:m", run(PLAIN, LESSON_BLOCK)),
      paragraph("w-q1", "R4Lv4 Paragraph Styles:4_WAI:q1", run(PLAIN, LESSON_QUOTE)),
      paragraph("w-qr", "R4Lv4 Paragraph Styles:4_WAI:qr", run(PLAIN, LESSON_QUOTE_REF)),
      paragraph("w-story-ms1", "R4Lv4 Paragraph Styles:5_Story:ms1", run(PLAIN, STORY_TITLE)),
      paragraph(
        "w-story-list",
        "R4Lv4 Paragraph Styles:5_Story:li1",
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
          + STORY_STEPS.map((line) => `<Content>${line}</Content>`).join("<Br/>")
          + `</CharacterStyleRange>`,
      ),
      paragraph(
        "w-psalm-cl",
        "R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:cl",
        run(PLAIN, PSALM_HEADING),
      ),
      paragraph(
        "w-psalm-d",
        "R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:d-h",
        run(PLAIN, PSALM_SUPERSCRIPTION),
      ),
      paragraph(
        "w-psalm-q",
        "R4Lv4 Paragraph Styles:7_Psalms:Poetry:q1",
        run(PLAIN, PSALM_LINE),
      ),
      "</Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

test("Reach 4 Life import brings in the workbook and not the Bible reading", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukEngR4Lv4_NT_FRT SECTION.idml")
  await writeReach4LifeFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Reach 4 Life ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture, async (dialog) => {
    // Reach 4 Life is a third InDesign template, so the importer only reads it
    // that way when this is ticked. It is off by default.
    const reach4Life = dialog.getByRole("checkbox", {
      name: /This is a Reach 4 Life file/i,
    })
    await expect(reach4Life).not.toBeChecked()
    await reach4Life.click()
    await expect(reach4Life).toBeChecked()

    // The editions are alternatives, so ticking one clears the other.
    await expect(dialog.getByRole("checkbox", {
      name: /This is a Treasure Hunt Bible file/i,
    })).not.toBeChecked()
  })

  await ws.openFileBySubstring("ukEngR4Lv4")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(9, { timeout: 15_000 })

  await expect(ws.cellRow(0)).toContainText(LESSON_TITLE)

  // With the split option on (default), a teaching block arrives as one cell
  // per sentence; export merges the sentences back into that paragraph.
  await expect(ws.cellRow(1)).toContainText(LESSON_SENTENCES[0].trim())
  await expect(ws.cellRow(1)).not.toContainText(LESSON_SENTENCES[1])
  await expect(ws.cellRow(2)).toContainText(LESSON_SENTENCES[1])

  // A verse quoted inside a lesson is part of the lesson, so it is translated
  // with it — unlike a continuous Bible reading.
  await expect(ws.cellRow(3)).toContainText(LESSON_QUOTE)
  await expect(ws.cellRow(4)).toContainText(LESSON_QUOTE_REF)

  await expect(ws.cellRow(5)).toContainText(STORY_TITLE)

  // A step list is one InDesign paragraph, but a translator works a line at a
  // time, so each line arrives as its own cell.
  await expect(ws.cellRow(6)).toContainText(STORY_STEPS[0])
  await expect(ws.cellRow(6)).not.toContainText(STORY_STEPS[1])
  await expect(ws.cellRow(7)).toContainText(STORY_STEPS[1])

  // The Reach 4 Life heading above the reading is Reach 4 Life copy, so it is
  // translated even though the reading underneath it is not.
  await expect(ws.cellRow(8)).toContainText(PSALM_HEADING)

  // The whole point of this importer: the published Bible text is not imported
  // for translation, even though the package has it.
  await expect(alice.getByText(PSALM_LINE)).toHaveCount(0)
  await expect(alice.getByText(PSALM_SUPERSCRIPTION)).toHaveCount(0)
  // Nor is page furniture.
  await expect(alice.getByText(RUNNING_HEAD, { exact: true })).toHaveCount(0)

  // Each Biblica edition lands in a folder of its own, so one project can hold
  // all three without their files mixing in the sidebar.
  await expect(alice.getByRole("button", { name: "Collapse Reach 4 Life" })).toBeVisible()

  // Lessons stay editable as normal target cells.
  await ws.editCell(0, "Qui suis-je ?")
  await expect(ws.cellRow(0)).toContainText("Qui suis-je ?")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})

test("Reach 4 Life file imported without the toggle explains what to tick", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukEngR4Lv4_NT_BCK SECTION.idml")
  await writeReach4LifeFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Reach 4 Life untoggled ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  const dialog = await ws.attemptImportViaSpecializedPanel(
    /Biblica Study Bible Notes/i,
    fixture,
  )

  // A Reach 4 Life file has no `intro:*` paragraphs, so the study-Bible reading
  // finds nothing — the error has to name the toggle that fixes it.
  await expect(dialog.getByText(/contained no study notes/i)).toBeVisible()
  await expect(dialog.getByText(/This is a Reach 4 Life file/i).first()).toBeVisible()
})
