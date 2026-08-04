import { test, expect, orgRoute } from "../../helpers/multi-user"

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
  `/project/${SEEDED_PROJECT_ID}/rules`,
  `/project/${SEEDED_PROJECT_ID}/terminology`,
  `/project/${SEEDED_PROJECT_ID}/comments`,
  `/project/${SEEDED_PROJECT_ID}/memory`,
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
