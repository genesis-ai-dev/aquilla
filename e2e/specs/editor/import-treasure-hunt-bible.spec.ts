import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_treasure_hunt.xml"

const FRONT_MATTER = "Copyright 2017 by Biblica, Inc. All rights reserved worldwide."
const INTRO_HEAD = "What is this book about?"
const FACT_HEAD = "Genesis 1:1"
const HUNT_HEAD = "Genesis 3:8-10"
const HUNT_NOTE = "Hearty has a question for you about the garden."
const SCRIPTURE = "In the beginning, God created the heavens and the earth."
const SECTION_HEAD = "The Beginning"
/** One InDesign paragraph, its items separated by line breaks. */
const HUNT_STEPS = [
  "Give some of your toys to a creche.",
  "Ask your friends to bring tinned food to your party.",
] as const
/** One InDesign paragraph holding several sentences of a fact block. */
const FACT_SENTENCES = [
  "To create something means to make something new. ",
  "It means to make something that did not exist before.",
] as const
const FACT_BLOCK = FACT_SENTENCES.join("")

const PLAIN = "$ID/[No character style]"

function run(characterStyle: string, text: string): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${characterStyle}">`
    + `<Content>${text}</Content></CharacterStyleRange>`
}

function paragraph(self: string, paragraphStyle: string, inner: string): string {
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="ParagraphStyle/${paragraphStyle}">`
    + inner
    + `</ParagraphStyleRange>`
}

/**
 * A Treasure Hunt Bible page: front matter, a book introduction, the published
 * NIrV text with its section head, a fact block anchored to a chapter, and a
 * hunt whose steps are set as one line-broken paragraph.
 */
async function writeTreasureHuntFixture(filePath: string): Promise<void> {
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
      `<idPkg:Story ${IDPKG}><Story Self="u300">`,
      paragraph("p-fm", "par_center", run(PLAIN, FRONT_MATTER)),
      paragraph("p-book", "_intro_book_long", run(PLAIN, "Genesis")),
      paragraph("p-ihead", "_intro_head", run(PLAIN, INTRO_HEAD)),
      paragraph("p-title", "pTitleMain", run(PLAIN, "Genesis")),
      paragraph("p-shead", "pSectionHead", run(PLAIN, SECTION_HEAD)),
      paragraph(
        "p-v1",
        "CHAP1pNormalAfterSectionHead",
        run("cChapterKern", "1") + run("cVerse", "1") + run(PLAIN, SCRIPTURE),
      ),
      paragraph("p-fhead", "!meta_fact_head", run(PLAIN, FACT_HEAD)),
      paragraph("p-fact", "!meta_par", run(PLAIN, FACT_BLOCK)),
      paragraph("p-hhead", "!meta_hunt_head", run(PLAIN, HUNT_HEAD)),
      paragraph("p-hunt", "!meta_par_ns", run(PLAIN, HUNT_NOTE)),
      paragraph(
        "p-steps",
        "!meta_hunt_list",
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
          + HUNT_STEPS.map((line) => `<Content>${line}</Content>`).join("<Br/>")
          + `</CharacterStyleRange>`,
      ),
      paragraph("p-rh", "#rh_verso", run(PLAIN, "| GENESIS")),
      "</Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

test("Treasure Hunt Bible import brings in everything around the Bible text", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukNIRV13_THB-01-05-Gen-Deu.idml")
  await writeTreasureHuntFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Treasure Hunt ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture, async (dialog) => {
    // The Treasure Hunt template is a different InDesign template, so the
    // importer only reads it that way when this is ticked. It is off by default.
    const treasureHunt = dialog.getByRole("checkbox", {
      name: /This is a Treasure Hunt Bible file/i,
    })
    await expect(treasureHunt).not.toBeChecked()
    await treasureHunt.click()
    await expect(treasureHunt).toBeChecked()

    // Sentence split is opt-out; the default keeps blocks one cell per sentence.
    await expect(dialog.getByRole("checkbox", {
      name: /Split long notes into one cell per sentence/i,
    })).toBeChecked()
  })

  await ws.openFileBySubstring("ukNIRV13_THB")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(10, { timeout: 15_000 })

  // Front matter and the book introduction are content set around the Bible
  // text, so both are translated here.
  await expect(ws.cellRow(0)).toContainText(FRONT_MATTER)
  await expect(ws.cellRow(1)).toContainText("Genesis")
  await expect(ws.cellRow(2)).toContainText(INTRO_HEAD)

  // The fact heading names the passage its block is about, and is itself
  // translated copy.
  await expect(ws.cellRow(3)).toContainText(FACT_HEAD)

  // With the split option on (default), a fact block arrives as one cell per
  // sentence; export merges the sentences back into that paragraph.
  await expect(ws.cellRow(4)).toContainText(FACT_SENTENCES[0].trim())
  await expect(ws.cellRow(4)).not.toContainText(FACT_SENTENCES[1])
  await expect(ws.cellRow(5)).toContainText(FACT_SENTENCES[1])

  await expect(ws.cellRow(6)).toContainText(HUNT_HEAD)
  await expect(ws.cellRow(7)).toContainText(HUNT_NOTE)

  // A hunt's steps are one InDesign paragraph, but a translator works a line at
  // a time, so each line arrives as its own cell.
  await expect(ws.cellRow(8)).toContainText(HUNT_STEPS[0])
  await expect(ws.cellRow(8)).not.toContainText(HUNT_STEPS[1])
  await expect(ws.cellRow(9)).toContainText(HUNT_STEPS[1])

  // The whole point of this importer: the published Bible text and its section
  // headings are not imported for translation, even though the package has them.
  await expect(alice.getByText(SCRIPTURE)).toHaveCount(0)
  await expect(alice.getByText(SECTION_HEAD, { exact: true })).toHaveCount(0)

  // Each Biblica edition lands in a folder of its own, so one project can hold
  // all three without their files mixing in the sidebar.
  await expect(alice.getByRole("button", { name: "Collapse Treasure Hunt Bible" })).toBeVisible()

  // Notes carry the chapter their block heading named, so the universal
  // navigator groups them by passage.
  await expect(alice.getByRole("button", {
    name: /Current chapter: Genesis Intro/,
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("button", {
    name: /Current chapter: Genesis 1/,
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("button", {
    name: /Current chapter: Genesis 3/,
  })).toBeVisible()

  // Notes stay editable as normal target cells.
  await ws.editCell(0, "Droits d'auteur Biblica.")
  await expect(ws.cellRow(0)).toContainText("Droits d'auteur Biblica.")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})

test("Treasure Hunt volume imported without the toggle explains what to tick", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("ukNIRV13_THB-59-Jas.idml")
  await writeTreasureHuntFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Treasure Hunt untoggled ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  const dialog = await ws.attemptImportViaSpecializedPanel(
    /Biblica Study Bible Notes/i,
    fixture,
  )

  // A Treasure Hunt volume has no `intro:*` paragraphs, so the study-Bible
  // reading finds nothing — the error has to name the toggle that fixes it.
  await expect(dialog.getByText(/contained no study notes/i)).toBeVisible()
  await expect(dialog.getByText(/This is a Treasure Hunt Bible file/i).first()).toBeVisible()
})
