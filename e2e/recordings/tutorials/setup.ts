import { expect, type Page } from "@playwright/test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
export const PSALM_23 = path.join(FIXTURES, "psalm-23.usfm")

/**
 * Put a recording on each of the demo's six verses, through Import →
 * Recordings as a person would. Runs before a take starts, so it is not in
 * the video.
 */
export async function uploadSampleRecordings(page: Page): Promise<void> {
  const dir = path.join(FIXTURES, "recordings")
  const files = readdirSync(dir).map((name) => path.join(dir, name))
  await page.getByRole("button", { name: /^Import$/ }).first().click()
  const dialog = page.getByRole("dialog", { name: "Import" })
  await expect(dialog.getByText("What are you importing?")).toBeVisible()
  await dialog.getByRole("radio", { name: "Recordings" }).click()
  await page.locator('input[type="file"]').first().setInputFiles(files)
  const confirm = page.getByTestId("recordings-confirm")
  await expect(confirm).toHaveText(`Upload ${files.length} recordings`, { timeout: 15_000 })
  await confirm.click()
  await expect(page.getByTestId("recordings-confirm")).toBeHidden({ timeout: 60_000 })
}

/** Switch the open file to the Media view and wait for its takes. */
export async function openMediaView(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Media" }).click()
  await expect(page.getByRole("button", { name: /^Take Play this clip/ }).first()).toBeVisible({ timeout: 20_000 })
}

/** The demo organization: the first one the demo sign-in makes. */
export const DEMO_ORG = "/orgs/1"

/** Start a take on another page than the editor (off camera, in its setup). */
export function startOn(path: string, ready: (page: Page) => Promise<unknown>) {
  return async (page: Page): Promise<void> => {
    await page.goto(path)
    await ready(page)
  }
}
