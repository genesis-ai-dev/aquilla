import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AQU-737 — opening a project blocks the whole surface while in flight.
 *
 * The workspace (`/project/:id/editor`) is a lazy route, so clicking
 * "Open project" has a real async window while its chunk downloads. During
 * that window the clicked control spins + disables AND a viewport-wide
 * "Opening project…" overlay (data-testid `workspace-opening-overlay`)
 * swallows clicks aimed at every other control, so nothing else can be
 * activated mid-transition. Back-navigating before the chunk lands aborts
 * the transition and returns the surface to idle/clickable.
 *
 * The chunk fetch is made observable by gating `assets/app-chunk-*.js`
 * requests (all lazy chunks share that anonymized name) behind a promise the
 * test releases — state-based, no timers.
 */
test("Open project shows a blocking overlay until the workspace chunk lands; back-navigation aborts to idle", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Open overlay ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // createProject navigates to /projects/:id — wait until the overview is
  // fully interactive so the chunk gate below cannot trap the overview's own
  // resources.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  // The control's accessible name flips from "Open project" (idle) to
  // "Loading Opening…" (pending), so the locator must match both states.
  const openBtn = alice.getByRole("button", { name: /Open project|Opening…/ }).first()
  await expect(openBtn).toBeVisible({ timeout: 10_000 })

  // Gate every lazy chunk fetched from here on (the workspace chunk among
  // them) until the test explicitly releases it.
  let releaseChunks!: () => void
  const chunkGate = new Promise<void>((resolve) => {
    releaseChunks = resolve
  })
  await alice.route("**/assets/app-chunk-*.js", async (route) => {
    await chunkGate
    await route.continue()
  })

  const overlay = alice.getByTestId("workspace-opening-overlay")
  try {
    await openBtn.click()

    // In-flight: viewport-blocking overlay with the shared spinner pill…
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute("aria-busy", "true")
    await expect(overlay.locator("[data-slot='spinner']")).toBeVisible()
    await expect(overlay.getByText("Opening project…")).toBeVisible()
    // …and the clicked control is disabled, so it cannot fire again.
    await expect(openBtn).toBeDisabled()

    // Another control (breadcrumb "All organizations") sits beneath the
    // overlay. A raw mouse click at its coordinates must be swallowed — if it
    // landed, we would navigate to /orgs/all and the workspace assertions
    // below would fail loudly.
    const breadcrumbHome = alice
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "All organizations", exact: true })
    const box = await breadcrumbHome.boundingBox()
    expect(box).toBeTruthy()
    await alice.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)

    // Abort: back-navigate before the chunk lands. The transition is
    // superseded, the overlay clears, and the control returns to idle.
    await alice.goBack()
    await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 10_000 })
    await expect(overlay).toBeHidden()
    await expect(openBtn).toBeEnabled()
  } finally {
    releaseChunks()
  }

  // With chunks flowing again, opening completes: workspace renders and the
  // overlay is gone.
  await openBtn.click()
  await expect(alice.locator('[aria-label="Filter files"]')).toBeVisible({ timeout: 10_000 })
  await expect(overlay).toBeHidden()
})
