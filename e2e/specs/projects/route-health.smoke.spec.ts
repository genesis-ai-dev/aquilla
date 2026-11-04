import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * Route-health sweep: every named route renders without a crash boundary
 * or unhandled JS exception. Uses the bestalu-bible seeded project which
 * has 66 files + all feature routes enabled.
 *
 * Verified manually 2026-06-08: 15/15 routes clean against the dev-stack
 * (DEV_STACK_IDENTITY_PORT=8790 DEV_STACK_SYNC_PORT=8791 pnpm dev).
 */
const SEEDED_PROJECT_ID = "41ee4729-6862-51b1-b89c-47401d1a7850" // bestalu-bible

const PROJECT_ROUTES = [
  `/project/${SEEDED_PROJECT_ID}/editor`,
  `/project/${SEEDED_PROJECT_ID}/settings`,
  `/project/${SEEDED_PROJECT_ID}/settings/members`,
  `/project/${SEEDED_PROJECT_ID}/settings/rules`,
  `/project/${SEEDED_PROJECT_ID}/settings/memory`,
  `/project/${SEEDED_PROJECT_ID}/rules`,
  `/project/${SEEDED_PROJECT_ID}/terminology`,
  `/project/${SEEDED_PROJECT_ID}/comments`,
  `/project/${SEEDED_PROJECT_ID}/memory`,
  // AQU-932: Living Memory section panes (settings/{rules,memory} above now
  // exercise the legacy redirects into this surface).
  `/project/${SEEDED_PROJECT_ID}/memory/instructions`,
  `/project/${SEEDED_PROJECT_ID}/memory/quality`,
  `/project/${SEEDED_PROJECT_ID}/voice`,
]

test("all org-level routes render without errors", async ({ alice }) => {
  const ORG_ROUTES = [
    "/",
    "/projects",
    orgRoute(alice, "/archived"),
    orgRoute(alice, "/assigned"),
    orgRoute(alice, "/teams"),
    orgRoute(alice, "/members"),
    orgRoute(alice, "/settings"),
    "/preferences",
  ]
  for (const route of ORG_ROUTES) {
    await alice.goto(route)
    // No crash boundary.
    await expect(alice.locator("text=/Something went wrong/i")).not.toBeVisible()
    // No unhandled error overlay from Vite.
    await expect(alice.locator("vite-error-overlay")).not.toBeAttached()

    const errors = await alice.evaluate(() =>
      (window as unknown as { __e2e_errors?: string[] }).__e2e_errors ?? []
    ).catch(() => [])
    expect(errors, `console errors on ${route}`).toHaveLength(0)
  }
})

test("all project-level routes render without errors", async ({ alice }) => {
  for (const route of PROJECT_ROUTES) {
    await alice.goto(route)
    await expect(alice.locator("text=/Something went wrong/i")).not.toBeVisible()
    await expect(alice.locator("vite-error-overlay")).not.toBeAttached()
  }
})

// AQU-2377: a fresh document has never downloaded the editor's lazy assets.
for (const failure of ["browser-offline", "unreachable-host"] as const) {
  test(`first offline editor visit explains the missing screen and recovers on reconnect (${failure})`, async ({ alice }) => {
    const { jwtFor, seedProjectWithFile } = await import("../../helpers/seed-project")
    const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: "Cold offline editor" })
    await alice.goto(`/projects/${seeded.projectId}`)
    await expect(alice.getByRole("button", { name: "Open project", exact: true })).toBeVisible()
    if (failure === "browser-offline") {
      await alice.context().setOffline(true)
    } else {
      // Native Safari can keep navigator.onLine=true while requests fail.
      await alice.route("**/assets/**", route => route.abort("internetdisconnected"))
      // The affected pre-push gate also runs the unbundled Vite dev server.
      await alice.route("**/src/components/ProjectWorkspace.tsx*", route => route.abort("internetdisconnected"))
      await alice.route("**/version.json", route => route.abort("internetdisconnected"))
    }
    try {
      await alice.getByRole("button", { name: "Open project", exact: true }).click()
      await expect(alice.getByText("Connect to load this screen", { exact: true })).toBeVisible()
      await expect(alice.getByText("Something went wrong", { exact: true })).not.toBeVisible()
      await expect(alice.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
    } finally {
      await alice.context().setOffline(false)
      if (failure === "unreachable-host") {
        await alice.unroute("**/assets/**")
        await alice.unroute("**/src/components/ProjectWorkspace.tsx*")
        await alice.unroute("**/version.json")
      }
    }
    await expect(alice.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    // Reconnect alone must leave recovery under the user's control.
    await expect(alice.getByText("Your browser is back online. Reload to try loading this screen again.", { exact: true })).toBeVisible()
    await alice.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(alice.locator('[data-slot="error-boundary-fallback"]')).not.toBeVisible()
    await expect(alice.getByRole("button", { name: /Account menu: alice/ })).toBeVisible()
    await expect(alice.getByText("Connect to load this screen", { exact: true })).not.toBeVisible()
    await new Workspace(alice).waitForEditor(seeded.cellIds[0])
  })
}
