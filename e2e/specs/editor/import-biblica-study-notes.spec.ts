import { test, expect } from "../../helpers/multi-user"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_biblica.xml"

const GLOBAL_PREFACE_NOTE = "GEN — General notes prepared for this edition."
const PREFACE_NOTE = "Genesis introduces the story of beginnings."
const CHAPTER_ONE_NOTE = "God alone creates the heavens and the earth."
const SCRIPTURE = "In the beginning God created the heavens and the earth."
/** One InDesign paragraph, its items separated by line breaks. */
const REFERENCE_LIST = [
  "Creation: Genesis 1:1-2:25.",
  "Covenant: Genesis 12:1-9.",
] as const
/** One InDesign paragraph holding several sentences of commentary. */
const NOTE_BLOCK_SENTENCES = [
  "1:1-2:3 The account of creation is told as a week of work. ",
  "Each day is introduced by the same formula and closed by an evening refrain.",
] as const
const NOTE_BLOCK = NOTE_BLOCK_SENTENCES.join("")
/** A note that InDesign flushed the previous verse's closing marker into. */
const MARKER_NOTE = "The account closes where the next book begins."
/** The chapter/verse markers that end a book: no words, so no cell. */
const STRAY_MARKER = "50:26"
/** A Psalter chapter label. JOB-SNG sets these in `head:cl`, not `intro:*`. */
const PSALM_HEADING = "Psalm 2"
/** Poetry that belongs to the Bible text, not to the notes. */
const PSALM_VERSE = "Why do the nations conspire?"

/** The division heading that introduces a group of books, ahead of its title. */
const DIVISION_HEADING = "Israelʼs covenant history"
const DIVISION_NOTE = "The books from Genesis to Esther record Israelʼs story."
const BOOK_TITLE = "Genesis"

/** A front/back matter volume: the Bible Dictionary, which holds no scripture. */
const DICTIONARY_TITLE = "Bible Dictionary"
const DICTIONARY_ENTRY = "Aaron: Exodus 4:14. Page 89"
const DICTIONARY_BODY = "Aaron was the first priest of Israel."
const DICTIONARY_SECOND_ENTRY = "Babel: Genesis 11:1-9. Page 24"
/** InDesign regenerates the running head from the layout, so it is not text. */
const RUNNING_HEAD = "Bible Dictionary 1701"

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
 * A Biblica study-Bible page: a document-level note before `meta:bk`, a
 * book-level note before any scripture, one fully marked-up verse, a note about
 * that chapter, a reference list set as a single line-broken paragraph, a
 * multi-sentence note block, and the chapter/verse markers InDesign flushes out
 * of the last verse into the paragraphs that follow it.
 */
async function writeIdmlPackage(filePath: string, paragraphs: readonly string[]): Promise<void> {
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
      `<idPkg:Story ${IDPKG}><Story Self="u200">`,
      ...paragraphs,
      "</Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

async function writeBiblicaFixture(filePath: string): Promise<void> {
  await writeIdmlPackage(filePath, [
      paragraph("p-global-pref", "intro%3aip", run(PLAIN, GLOBAL_PREFACE_NOTE)),
      paragraph("p-bk", "meta%3abk", run(PLAIN, "GEN")),
      // The division heading and its description introduce Genesis to Esther,
      // not Genesis, so they get a bookmark of their own.
      paragraph("p-div", "intro%3aimt2", run(PLAIN, DIVISION_HEADING)),
      paragraph("p-div-note", "intro%3aip", run(PLAIN, DIVISION_NOTE)),
      paragraph("p-title", "intro%3aimt1", run(PLAIN, BOOK_TITLE)),
      paragraph("p-pref", "intro%3aip", run(PLAIN, PREFACE_NOTE)),
      paragraph(
        "p-v1",
        "cv%3ap",
        run("cv%3adc", "1")
          + run("cv%3av1", "1")
          + run("meta%3av", "1")
          + run(PLAIN, SCRIPTURE)
          + run("meta%3av", "1"),
      ),
      paragraph(
        "p-n1",
        "intro%3aipi",
        run(PLAIN, "God alone creates ")
          + run("Bold", "the heavens and the earth."),
      ),
      paragraph(
        "p-list",
        "intro%3aili1",
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
          + REFERENCE_LIST.map((line) => `<Content>${line}</Content>`).join("<Br/>")
          + `</CharacterStyleRange>`,
      ),
      paragraph("p-n2", "intro%3aip", run(PLAIN, NOTE_BLOCK)),
      paragraph("p-n3", "intro%3aipi", run(PLAIN, MARKER_NOTE) + run("meta%3av", "26")),
      paragraph("p-ie", "intro%3aie", run("meta%3ac", "50:") + run("meta%3av", "26")),
      paragraph("p-cl", "head%3acl", run(PLAIN, PSALM_HEADING)),
      paragraph(
        "p-q",
        "text%3aq1",
        run("cv%3av1", "1")
          + run("meta%3av", "1")
          + run(PLAIN, PSALM_VERSE)
          + run("meta%3av", "1"),
      ),
  ])
}

/**
 * A front/back matter volume, in the shape of the Bible Dictionary: no
 * scripture anywhere, text set in layout styles rather than `intro:*` notes,
 * a section per alphabet letter, and the running head InDesign regenerates.
 */
async function writeBiblicaFrontBackFixture(filePath: string): Promise<void> {
  await writeIdmlPackage(filePath, [
    paragraph("p-title", "intro%3aimt2", run(PLAIN, DICTIONARY_TITLE)),
    paragraph("p-a", "head%3ams1", run(PLAIN, "A")),
    paragraph("p-a1", "text%3ap", run(PLAIN, DICTIONARY_ENTRY)),
    paragraph("p-a2", "text%3am", run(PLAIN, DICTIONARY_BODY)),
    paragraph("p-rh", "meta%3arh", run(PLAIN, RUNNING_HEAD)),
    paragraph("p-b", "head%3ams1", run(PLAIN, "B")),
    paragraph("p-b1", "text%3ap", run(PLAIN, DICTIONARY_SECOND_ENTRY)),
  ])
}

test("Biblica study Bible import brings in the notes and leaves the scripture out", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("genesis-notes.idml")
  await writeBiblicaFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Biblica notes ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture, async (dialog) => {
    await expect(dialog.getByRole("checkbox", {
      name: /Split long notes into one cell per sentence/i,
    })).not.toBeChecked()
  })

  // The importer drops the "-notes" suffix, so the file reads as its book.
  await ws.openFileBySubstring("genesis")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  // Ten note cells from the fixture, plus the flushed-marker note and the
  // Psalm heading; the marker-only paragraph and the poetry line own no cell.
  // Sentence splitting is off.
  await expect(rows).toHaveCount(11, { timeout: 15_000 })
  await expect(ws.cellRow(0)).toContainText(GLOBAL_PREFACE_NOTE)
  await expect(ws.cellRow(1)).toContainText(DIVISION_HEADING)
  await expect(ws.cellRow(2)).toContainText(DIVISION_NOTE)
  await expect(ws.cellRow(3)).toContainText(BOOK_TITLE)
  await expect(ws.cellRow(4)).toContainText(PREFACE_NOTE)
  await expect(ws.cellRow(5)).toContainText(CHAPTER_ONE_NOTE)

  // The reference list is one InDesign paragraph, but a translator works a line
  // at a time, so each line arrives as its own cell.
  await expect(ws.cellRow(6)).toContainText(REFERENCE_LIST[0])
  await expect(ws.cellRow(6)).not.toContainText(REFERENCE_LIST[1])
  await expect(ws.cellRow(7)).toContainText(REFERENCE_LIST[1])

  // With sentence splitting off (default), the note block stays one cell.
  await expect(ws.cellRow(8)).toContainText(NOTE_BLOCK_SENTENCES[0].trim())
  await expect(ws.cellRow(8)).toContainText(NOTE_BLOCK_SENTENCES[1])

  // InDesign flushes a book's closing chapter/verse markers into the paragraphs
  // that follow it. They hold no words, so the note they landed on keeps its own
  // text and the paragraph that holds nothing else owns no cell at all.
  await expect(ws.cellRow(9)).toContainText(MARKER_NOTE)
  await expect(ws.cellRow(9)).not.toContainText("26")
  await expect(alice.getByText(STRAY_MARKER)).toHaveCount(0)

  // Psalm labels live in `head:cl`, not `intro:*`. They are still notes — the
  // poetry under them is the Bible text and stays out.
  await expect(ws.cellRow(10)).toContainText(PSALM_HEADING)
  await expect(alice.getByText(PSALM_VERSE)).toHaveCount(0)

  // Notes retain Biblica's richer Preface/chapter grouping in the universal
  // navigator while verse paragraphs remain protected source structure.
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Preface/,
  })).toBeVisible()
  await alice.getByRole("combobox", { name: /Current chapter: Preface/ }).click()
  await expect(alice.getByRole("option", { name: /^Cells 1–1 / }))
    .toHaveAttribute("data-milestone-subsection")
  await alice.keyboard.press("Escape")
  // A division heading introduces a group of books, so it is a bookmark of its
  // own — its cells sit ahead of the book the heading is printed in front of.
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current chapter: ${DIVISION_HEADING}`),
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Genesis Preface/,
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Genesis 1/,
  })).toBeVisible()
  await expect(ws.cellRow(5)).toBeVisible()

  // The whole point of this importer: the Bible text is not imported for
  // translation, even though it was present in the package.
  await expect(alice.getByText(SCRIPTURE)).toHaveCount(0)

  // Each Biblica edition lands in a folder of its own, so one project can hold
  // all three without their files mixing in the sidebar.
  await expect(alice.getByRole("button", { name: "Collapse Biblica Study Notes" })).toBeVisible()

  // AQU-742: reproduce the real replace failure — an existing multi-style
  // target, followed by a model response that keeps every slot identity/text
  // but adds contenteditable="false" to an editable slot. The client must
  // rebuild canonical HTML from those slots and leave the row terminal.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await applyUserProviderOverride(alice, alice.username, `${llmBase}/v1`)
  await alice.reload()
  await ws.waitForEditor()
  await ws.editCell(5, "Traduction existante.")
  await alice.route("**/v1/chat/completions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON() as {
      messages?: Array<{ content?: string }>
    }
    const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? ""
    const start = prompt.indexOf('<p data-idml-version="2">')
    const end = prompt.indexOf("</p>", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const canonical = prompt.slice(start, end + 4)
    const damaged = canonical.replace(
      'data-idml-protected="slot"',
      'data-idml-protected="slot" contenteditable="false"',
    )
    expect(damaged).not.toBe(canonical)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: damaged } }],
      }),
    })
  })
  const aiRow = ws.cellRow(5)
  await aiRow.hover()
  const sparkle = aiRow.locator(
    "[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']",
  ).first()
  await expect(sparkle).toBeVisible()
  await sparkle.click()
  await alice.getByRole("button", { name: /Replace|Overwrite|Continue/i }).click()
  await expect(aiRow.locator('[data-cell-type="target"]'))
    .toContainText(CHAPTER_ONE_NOTE, { timeout: 15_000 })
  await expect(aiRow).not.toHaveAttribute("data-ai-translating", "true")
  await expect(
    alice.getByText(/AI draft changed a protected IDML anchor/i),
  ).toHaveCount(0)

  // Notes stay editable as normal target cells.
  await ws.editCell(0, "Notes générales.")
  await expect(ws.cellRow(0)).toContainText("Notes générales.")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})

test("Biblica front and back matter imports as layout text grouped by its headings", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("bible-dictionary.idml")
  await writeBiblicaFrontBackFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Biblica back matter ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  // Same panel, no extra toggle: a volume with no scripture in it is read as
  // front/back matter on its own.
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture)

  await ws.openFileBySubstring("bible-dictionary")
  await ws.waitForEditor()

  // Every text-bearing paragraph is a cell here, because this volume sets its
  // text in layout styles rather than in the study-note styles.
  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(6, { timeout: 15_000 })
  await expect(ws.cellRow(0)).toContainText(DICTIONARY_TITLE)
  await expect(ws.cellRow(1)).toContainText("A")
  await expect(ws.cellRow(2)).toContainText(DICTIONARY_ENTRY)
  await expect(ws.cellRow(3)).toContainText(DICTIONARY_BODY)
  await expect(ws.cellRow(5)).toContainText(DICTIONARY_SECOND_ENTRY)

  // InDesign regenerates the running head from the layout, so it is not text a
  // translator should be asked to retype.
  await expect(alice.getByText(RUNNING_HEAD)).toHaveCount(0)

  // The volume's own headings are its bookmarks — one per alphabet letter in
  // the real dictionary — since it has no chapters to group by.
  await expect(alice.getByRole("combobox", {
    name: new RegExp(`Current chapter: ${DICTIONARY_TITLE}`),
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", { name: /Current chapter: A/ })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", { name: /Current chapter: B/ })).toBeVisible()

  // It lands in the same Biblica folder as the notes it belongs with.
  await expect(alice.getByRole("button", { name: "Collapse Biblica Study Notes" })).toBeVisible()

  await ws.editCell(2, "Aaron : Exode 4.14. Page 89")
  await expect(ws.cellRow(2)).toContainText("Aaron : Exode 4.14. Page 89")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})
