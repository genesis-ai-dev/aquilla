import { test } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
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
 * local-first durability (IndexedDB), the trust-builder for translators on
 * flaky connectivity.
 *
 * Uses the DEFAULT `page` fixture (not the multi-user fixture) so Playwright's
 * config-level `video: on` records the take — the multi-user fixture builds
 * its context via browser.newContext() without recordVideo, so it produces no
 * video. We authenticate by injecting alice's session with the same helpers
 * the fixture uses.
 *
 * The take is RESILIENT: it always drives the real authenticated app and
 * narrates the persona story via the in-frame branded overlay, attempts the
 * full money moment, records whether the value actually rendered
 * (verified flag), and ALWAYS finalizes a real .webm + storyboard — never
 * crashing, and never silently shipping a value claim that didn't render.
 */
test("P1 · Field Translator — local-first translation, saved the instant you type", async ({ page }) => {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)

  const show = new Showcase(page, {
    persona: "p1-field-translator",
    feature: "local-first-editing",
    title: "Translate anywhere. Saved the instant you type.",
    cta: "Aquilla — your source text and your translation, always in sync. Online or off.",
  })

  let verified = false
  try {
    const dash = new Dashboard(page)
    await dash.goto()
    await show.chapter("Meet the field translator", "Limited connectivity. Zero tolerance for lost work.")
    await show.caption("This is your workspace — every project, one place.")

    const name = "Luke — Eastern dialect"
    await show.chapter("Start a translation", "Bring your own source: Markdown, USFM, DOCX.")
    await show.caption("Spin up a project in seconds.")
    await dash.createProject({ name, source: "en", target: "fr" })
    await dash.openProject(name)

    const ws = new Workspace(page)
    await show.caption("Import your source. Aquilla segments it into cells automatically.")
    await ws.importFile(SAMPLE_MD)
    await ws.openFileBySubstring("sample")
    await ws.waitForEditor()

    await show.chapter("Translate, cell by cell", "Every keystroke persisted locally first.")
    const draft = "Voici la traduction du premier passage."
    await show.caption("Type your translation — saved the moment you move on.")
    await ws.editCell(0, draft)
    await show.beat(1000)

    await show.chapter("It survives anything", "Reload, lose signal, close the laptop — still here.")
    await show.caption("Reload the page…")
    await page.reload()
    await page.waitForLoadState("networkidle")
    await ws.openFileBySubstring("sample")
    await ws.waitForEditor()

    verified = (await ws.readCell(0)).includes(draft)
    await show.caption(
      verified
        ? "…and nothing is lost. Local-first means your work is yours."
        : "Local-first: your work lives on-device first, syncing when you reconnect.",
    )
    await show.beat(1500)
  } catch (err) {
    console.log(`[showcase] P1 take ran in degraded mode: ${(err as Error).message}`)
    await show.caption("Local-first: your work lives on-device first, syncing when you reconnect.")
    await show.beat(1200)
  } finally {
    await show.save(verified)
  }
})
