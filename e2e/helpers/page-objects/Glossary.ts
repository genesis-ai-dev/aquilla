import { type Locator, type Page, expect } from "@playwright/test"
import { pickSelectOption } from "../base-ui"

// This route hydrates project access, files, settings, and terminology before
// replacing the workspace loading overlay. Under isolated shard contention it
// can legitimately exceed the ordinary 10-second interaction budget.
const GLOSSARY_READY_TIMEOUT_MS = 30_000

/** User-level interactions for the editor-style Glossary surface. */
export class Glossary {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/project/${projectId}/terminology`)
    await expect(this.page.getByRole("heading", { name: "Terminology" })).toBeVisible({
      timeout: GLOSSARY_READY_TIMEOUT_MS,
    })
  }

  row(sourceTerm: string): Locator {
    return this.page.locator('[data-testid="glossary-row"]').filter({
      has: this.page.getByRole("button", { name: sourceTerm, exact: true }),
    })
  }

  async addTerm(sourceTerm: string, rendering: string): Promise<Locator> {
    await this.page.getByRole("button", { name: "Add term" }).click()
    const dialog = this.page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByPlaceholder("New source term…").fill(sourceTerm)
    if (rendering) {
      await dialog.getByRole("textbox", { name: "Rendering", exact: true }).fill(rendering)
    }
    const saved = this.waitForTermEventFlush()
    await dialog.getByRole("button", { name: "Add term" }).click()
    await this.expectTermEventFlushOk(saved)
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    const row = this.row(sourceTerm)
    await expect(row).toBeVisible({ timeout: 8_000 })
    return row
  }

  async setRenderingStatus(sourceTerm: string, status: string): Promise<void> {
    const row = await this.expandTerm(sourceTerm)
    const statusSelect = row.getByRole("combobox", { name: "Rendering 1 status" })
    const saved = this.waitForTermEventFlush()
    await pickSelectOption(this.page, statusSelect, status)
    await this.expectTermEventFlushOk(saved)
  }

  // AQU-1006: glossary writes are term.* events through the outbox, flushed
  // as POST /events to the sync-worker — the settings blob is never PATCHed.
  private waitForTermEventFlush() {
    return this.page.waitForResponse((response) =>
      response.request().method() === "POST"
      && /\/events(?:\?|$)/.test(response.url()),
    )
  }

  private async expectTermEventFlushOk(responsePromise: ReturnType<Page["waitForResponse"]>) {
    const response = await responsePromise
    expect(response.ok(), `term event flush failed: HTTP ${response.status()}`).toBe(true)
  }

  async expandTerm(sourceTerm: string): Promise<Locator> {
    const row = this.row(sourceTerm)
    await row.getByRole("button", { name: "Expand renderings" }).click()
    await expect(row.getByRole("button", { name: "Collapse renderings" })).toBeVisible()
    return row
  }

  async editSource(sourceTerm: string, next: string): Promise<Locator> {
    const row = this.row(sourceTerm)
    const conceptId = await row.getAttribute("data-concept-id")
    expect(conceptId).toBeTruthy()
    await row.getByRole("button", { name: sourceTerm, exact: true }).click()
    const stableRow = this.page.locator(`[data-testid="glossary-row"][data-concept-id="${conceptId}"]`)
    const input = stableRow.locator("input").first()
    await input.fill(next)
    await input.press("Enter")
    const nextRow = this.row(next)
    await expect(nextRow).toBeVisible({ timeout: 8_000 })
    return nextRow
  }

  async setNotes(sourceTerm: string, notes: string): Promise<void> {
    const row = await this.expandTerm(sourceTerm)
    const field = row.getByRole("textbox", { name: `Notes for ${sourceTerm}` })
    await field.fill(notes)
    await field.blur()
  }

  async openDetails(sourceTerm: string): Promise<void> {
    const row = this.row(sourceTerm)
    await row.getByRole("button", { name: `Open details for ${sourceTerm}` }).click()
    await expect(this.page.getByRole("button", { name: "Close detail" })).toBeVisible({ timeout: 10_000 })
  }

  async openViolations(): Promise<void> {
    await this.page.getByRole("button", { name: "Violations" }).click()
    await expect(this.page.getByRole("button", { name: "Back to terminology" })).toBeVisible({ timeout: 10_000 })
  }

  async archiveTerm(sourceTerm: string): Promise<void> {
    const row = this.row(sourceTerm)
    await row.getByRole("button", { name: "Archive term" }).click()
    await expect(row).not.toBeVisible({ timeout: 8_000 })
  }

  async showArchived(): Promise<void> {
    await this.page.getByRole("button", { name: /Show archived/ }).click()
  }

  async restoreTerm(sourceTerm: string): Promise<void> {
    const row = this.row(sourceTerm)
    await row.getByRole("button", { name: "Restore term" }).click()
    await expect(row).toHaveAttribute("data-status", "active", { timeout: 8_000 })
  }

  async acceptSuggestedTerm(sourceTerm: string): Promise<void> {
    const row = this.row(sourceTerm)
    await row.getByRole("button", { name: "Accept term" }).click()
    await expect(row).toHaveAttribute("data-status", "active", { timeout: 8_000 })
  }
}
