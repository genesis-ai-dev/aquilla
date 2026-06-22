import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * P1 · The Field Translator — see docs/distribution/PERSONAS.md.
 *
 * Money moment: a translation typed into a cell survives a full reload —
 * local-first durability, the trust-builder for translators on flaky
 * connectivity. Built entirely on the proven import-and-edit page-object
 * flow (the green editor smoke), so this take runs against the live app
 * today. The Showcase helper burns chapters + captions into the frame and
 * emits the storyboard the assembler turns into announce/docs/market cuts.
 */
test("P1 · Field Translator — local-first translation, saved the instant you type", async ({ alice }) => {
  const show = new Showcase(alice, {
    persona: "p1-field-translator",
    feature: "local-first-editing",
    title: "Translate anywhere. Saved the instant you type.",
    cta: "Aquilla — your source text and your translation, always in sync. Online or off.",
  })

  const dash = new Dashboard(alice)
  await dash.goto()
  await show.chapter("Meet the field translator", "Limited connectivity. Zero tolerance for lost work.")
  await show.caption("Starting a new translation takes seconds.")

  const name = "Luke — Eastern dialect"
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await show.chapter("Bring your own source", "Markdown, USFM, DOCX — dropped straight in.")
  await show.caption("Import your source text. Aquilla segments it into cells automatically.")
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await show.chapter("Translate, cell by cell", "Every keystroke persisted locally first.")
  const draft = "Voici la traduction du premier passage."
  await show.caption("Type your translation — it's saved the moment you move on.")
  await ws.editCell(0, draft)
  await show.beat(1200)

  await show.chapter("It survives anything", "Reload, lose signal, close the laptop — still here.")
  await show.caption("Reload the page…")
  await alice.reload()
  await alice.waitForLoadState("networkidle")
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The take is only worth shipping if the value moment is REAL.
  await expect(ws.cellRow(0)).toContainText(draft, { timeout: 5_000 })
  await show.caption("…and nothing is lost. Local-first means your work is yours.")
  await show.beat(1500)

  await show.save()
})
