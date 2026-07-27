import { test, expect } from "@playwright/test"

/**
 * Marketing homepage "book a call" journey (#book-call on homepage.html, the
 * standalone marketing entry the edge Worker serves to signed-out visitors).
 *
 * Two paths must both exist:
 *   1. the Google Calendar booking link (the team's Workspace appointment
 *      schedule — same link the case-study pages use);
 *   2. the contact form, whose submission POSTs to the auth-worker's public
 *      POST /api/v2/contact/book-call and shows the sent state. This is the
 *      real cross-boundary path: the built page's baked VITE_AUTH_BASE →
 *      the shard's identity worker → zod validation → email service (a no-op
 *      returning delivered:false here, since the local worker has no EMAIL
 *      binding — the endpoint still responds 200).
 *
 * No auth or seeded users involved — the page is public. The per-IP contact
 * throttle can't bite across runs because each e2e-up boot drops and
 * recreates the shard database.
 */
test("homepage book-a-call: booking link present, form submits through the contact endpoint", async ({ page }) => {
  await page.goto("/homepage.html")

  const section = page.locator("#book-call")
  await section.scrollIntoViewIfNeeded()
  await expect(
    section.getByRole("heading", { name: /want to start\? book a call with us/i }),
  ).toBeVisible()

  // Path 1: the Google Calendar booking link.
  const bookingLink = section.getByRole("link", { name: /book a call/i })
  await expect(bookingLink).toHaveAttribute(
    "href",
    "https://calendar.app.google/umM8GMgm6d78mZWS9",
  )
  await expect(bookingLink).toHaveAttribute("target", "_blank")

  // Path 2: the form, submitted against the real identity worker.
  await section.getByLabel(/^name$/i).fill("Smoke Visitor")
  await section.getByLabel(/^email$/i).fill("smoke-visitor@example.com")
  await section.getByLabel(/organization/i).fill("E2E Harness")
  await section.getByLabel(/hoping to translate/i).fill("Just checking the wiring.")

  // The harness has no outside network — stub the external booking origin so
  // the popup's navigation commits and its URL is assertable deterministically.
  await page.context().route("https://calendar.app.google/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>booking stub</title>" }),
  )

  const submission = page.waitForResponse(
    (res) => res.url().includes("/api/v2/contact/book-call") && res.request().method() === "POST",
  )
  // A successful submit also opens the booking calendar in a new tab.
  const popupPromise = page.context().waitForEvent("page")
  await section.getByRole("button", { name: /send message/i }).click()

  const response = await submission
  expect(response.status()).toBe(200)

  await expect(section.getByText(/thanks — we'll be in touch/i)).toBeVisible()
  const popup = await popupPromise
  await popup.waitForURL(/calendar\.app\.google/)
  await popup.close()
  // The sent state still offers the calendar path as a fallback link.
  await expect(section.getByRole("link", { name: /grab a time on our calendar/i })).toHaveAttribute(
    "href",
    "https://calendar.app.google/umM8GMgm6d78mZWS9",
  )
})
