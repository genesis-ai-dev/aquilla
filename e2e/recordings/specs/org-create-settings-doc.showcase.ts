import { test, expect } from "@playwright/test"
import { Showcase } from "../helpers/showcase"

const APP_ORIGIN = "http://127.0.0.1:5173"
const ORG_NAME = "Northwind Bible Society"
const ORG_RENAMED = "Northwind Bible Society (Kenya)"

/**
 * Demo · Documentation walkthrough — creating an organization and changing its
 * settings, in the *clarity-first* profile of the showcase toolkit (mode:
 * "doc").
 *
 * A large programmatic cursor leads the eye to each control, clicks ripple, and
 * the region of interest is magnified with zoom-into-click — all over the REAL
 * app. We authenticate by driving the app's own `/__marketing/login` route
 * (src/components/MarketingLoginRoute.tsx), which persists the session through
 * the real session-store and lands on the curated project — so the org context
 * is fully hydrated before we navigate to the dashboard. The org is genuinely
 * created and genuinely renamed; both money moments are asserted before the
 * take is marked verified.
 */
test("Demo · Create an organization and change its settings", async ({ page }) => {
  // Bounded pacing — a wrong selector should fail well before the default 5 min.
  test.setTimeout(180_000)

  // The root guard (App.tsx RootRedirect) bounces "/" to /homepage unless the
  // aq_hint cookie is present. Set it so "/" resolves to OrgHome.
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: APP_ORIGIN }])

  // Authenticate through the app's own marketing login → it persists the
  // session and redirects to the curated project once logged in.
  await page.goto("/__marketing/login")
  await page.waitForURL(/\/project\/demo-john/, { timeout: 45_000 })

  const show = new Showcase(page, {
    persona: "demo-org-admin",
    feature: "create-org-and-settings",
    title: "Aquilla — create an organization and change its settings.",
    cta: "Aquilla — your team, your org, set up in seconds.",
    mode: "doc",
  })

  // Stable selectors (this app build has no @showcase labels for org chrome, so
  // we address real controls by role/aria/text).
  const SWITCHER = "button:has(svg.lucide-chevrons-up-down)"
  const CREATE_ORG = 'button:has-text("Create org")'
  const NAME_INPUT = 'input[aria-label="New org name"]'
  const CREATE_BTN = 'input[aria-label="New org name"] + button'
  const SETTINGS_LINK = 'a[href="/settings"]'
  const RENAME_BTN = 'button:has-text("Rename")'
  const SAVE_BTN = 'button:has-text("Save")'

  let verified = false
  try {
    // Move from the curated project to the org dashboard; the session/org
    // context is already hydrated, so the switcher renders.
    await page.goto("/")
    await page.locator(SWITCHER).first().waitFor({ state: "visible", timeout: 30_000 })

    // ── Chapter 1 — create the organization ──────────────────────────────
    await show.chapter("Create an organization", "Spin up a fresh org from the sidebar switcher.")
    await show.caption("Every workspace starts with an organization. Open the switcher.")
    await show.zoomTo(SWITCHER, { scale: 1.6 })
    await show.click(SWITCHER)
    await page.locator(CREATE_ORG).first().waitFor({ state: "visible", timeout: 10_000 })
    await show.beat(400)

    await show.caption("Choose “+ Create org”.")
    await show.click(CREATE_ORG)
    await page.locator(NAME_INPUT).waitFor({ state: "visible", timeout: 10_000 })
    await show.beat(300)

    await show.point(NAME_INPUT)
    await show.caption("Give it a name.")
    await page.fill(NAME_INPUT, ORG_NAME)
    await show.beat(500)

    await show.caption("…and create it.")
    await show.click(CREATE_BTN)
    await show.zoomReset()

    // Money moment 1 — the new org is real and now the active workspace.
    await expect(page.getByText(ORG_NAME, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    await show.chapter("Your organization is ready", `${ORG_NAME} is now your active workspace.`)
    await show.caption("Created — and switched to automatically.")
    await show.beat(900)

    // ── Chapter 2 — change its settings (rename) ─────────────────────────
    await show.chapter("Change its settings", "Open Settings to manage the organization.")
    await show.caption("Open Settings from the sidebar.")
    await show.click(SETTINGS_LINK)
    await expect(page.getByRole("heading", { name: /Organization settings/i })).toBeVisible({ timeout: 15_000 })
    await show.beat(400)

    await show.zoomTo(RENAME_BTN, { scale: 1.5 })
    await show.caption("In the Identity card, click Rename.")
    await show.click(RENAME_BTN)
    await show.zoomReset() // back to 1× so the edit form + Save are actionable
    await page.locator("#org-name").waitFor({ state: "visible", timeout: 10_000 })
    await show.beat(300)

    await show.point("#org-name")
    await show.caption("Edit the name…")
    await page.fill("#org-name", ORG_RENAMED)
    await show.beat(500)

    await show.caption("…and save.")
    await show.click(SAVE_BTN)
    await show.zoomReset()

    // Money moment 2 — the rename persisted and renders back in Identity.
    await expect(page.getByText(ORG_RENAMED, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    verified = true
    await show.chapter("Saved", "The new name propagates across the app instantly.")
    await show.caption("Settings saved — the new name is live everywhere.")
    await show.beat(1200)
  } catch (err) {
    console.log(`[showcase] org-setup doc take degraded: ${(err as Error).message}`)
    await show.caption("Org setup walkthrough — demo environment.")
    await show.beat(1000)
  } finally {
    await show.save(verified)
  }
})
