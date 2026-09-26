import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { readProjectSettings } from "../../helpers/frontier-api"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AQU-1271 — pointed source forms, project affixes, and per-form exclusions.
 *
 * The journey this protects crosses SPA → auth-worker (project shared
 * settings) → sync-worker (`term.update` events) → Postgres and back:
 *
 *   1. A pointed Hebrew term matches the SAME consonants under a DIFFERENT
 *      accent (`הָאָ֗רֶץ` selected, `הָאָֽרֶץ` in the text) — mark folding is on
 *      by default for a term that carries combining marks, so this holds with
 *      no project configuration at all.
 *   2. Loading the Hebrew affix preset in project settings and saving it makes
 *      the prefixed `וְהָאָ֗רֶץ` match too. That is the whole point of the
 *      shared `termMatching` inventory: it is a PROJECT setting that changes
 *      what every term matches, so it has to survive the settings PATCH and be
 *      read back by the terminology page.
 *   3. Excluding a discovered surface form drops it from the occurrence count
 *      and persists as a `term.update` event — the exclusion is still there
 *      after a reload, not just in React state.
 *
 * The bare `אֶ֔רֶץ` in the third cell never matches: affix stripping adds
 * prefixes to the term, it does not remove the term's own article.
 *
 * Fixture: `e2e/fixtures/genesis-1-pointed.md` (three pointed Hebrew lines).
 */

const TERM = "הָאָ֗רֶץ"
/** Same word carrying the conjunctive waw — only matches with a prefix inventory. */
const PREFIXED = "וְהָאָ֗רֶץ"
/** Same consonants, different accent — matches through mark folding alone. */
const VARIANT_POINTING = "הָאָֽרֶץ"

test("pointed term matches variant pointing and prefixes; exclusion sticks", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `Forms ${Date.now()}`,
    fixturePath: new URL("../../fixtures/genesis-1-pointed.md", import.meta.url).pathname,
  })
  await openSeededProject(alice, seeded)

  const glossary = new Glossary(alice)
  await glossary.goto(seeded.projectId)
  await glossary.addTerm(TERM, "earth")
  await glossary.openDetails(TERM)

  // Mark folding alone: the differently-accented הָאָֽרֶץ in cell 1 matches, the
  // prefixed form in cell 2 does not (no affix inventory yet).
  await expect(alice.getByTestId("term-forms")).toBeVisible({ timeout: 10_000 })
  await expect(glossary.occurrenceSummary()).toHaveText("1 occurrence")
  await expect(glossary.formChip(VARIANT_POINTING, "included")).toBeVisible()
  await expect(glossary.formsChips()).toHaveCount(1)

  // ── Project affix inventory (settings → AI & completion → Terminology) ─────
  await alice.goto(`/project/${seeded.projectId}/settings/ai`)
  // The "Prefixes and suffixes" group renders its label as body text, not a
  // heading — the preset trigger is the section's stable landmark.
  const loadPreset = alice.getByRole("button", { name: "Load preset", exact: true })
  await expect(loadPreset).toBeVisible({ timeout: 15_000 })
  await loadPreset.click()
  await alice.getByRole("menuitem", { name: "Hebrew", exact: true }).click()
  // The preset is loaded into the form, not yet persisted. Assert on the
  // inseparable ב: the waw this journey actually needs appears in BOTH the
  // prefix and suffix lists, so its chip is not a unique locator.
  await expect(alice.getByRole("button", { name: "Remove ב", exact: true })).toBeVisible()

  const settingsSaved = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH"
      && /\/api\/v2\/projects\/[^/]+\/settings$/.test(new URL(response.url()).pathname),
  )
  await alice.getByRole("button", { name: "Save changes", exact: true }).click()
  expect(
    (await settingsSaved).ok(),
    "project shared-settings PATCH (termMatching) failed",
  ).toBe(true)

  // The inventory is a SHARED setting: it has to be in auth-worker's blob, not
  // just in the page's React state.
  const stored = await readProjectSettings(await jwtFor("alice"), seeded.projectId)
  expect(stored.termMatching).toMatchObject({ prefixes: expect.arrayContaining(["ו"]) })

  // ── The saved inventory changes what the term matches ─────────────────────
  await glossary.goto(seeded.projectId)
  await glossary.openDetails(TERM)
  await expect(glossary.occurrenceSummary()).toHaveText("2 occurrences")
  await expect(glossary.formChip(PREFIXED, "included")).toBeVisible()
  await expect(glossary.formsChips()).toHaveCount(2)

  // ── Excluding a discovered form drops it from the count, and persists ─────
  await glossary.excludeForm(PREFIXED)
  await expect(glossary.occurrenceSummary()).toHaveText("1 occurrence")
  // The chip stays — excluded, not removed — so it can be toggled back on.
  await expect(glossary.formsChips()).toHaveCount(2)

  // The open term detail is a URL state (`?concept=<id>`), so the reload comes
  // back on the same panel — rebuilt from the server's concepts, not memory.
  await alice.reload()
  await expect(alice.getByTestId("term-forms")).toBeVisible({ timeout: 30_000 })
  await expect(glossary.formChip(PREFIXED, "excluded")).toBeVisible({ timeout: 10_000 })
  await expect(glossary.occurrenceSummary()).toHaveText("1 occurrence")
})
