import { type Page, type Locator, expect } from "@playwright/test"

/**
 * Page object for the standalone Living Memory surface
 * ("/project/:id/memory[/:section]", AQU-932).
 *
 * Living Memory is a settings-style index → pane drill-down inside the
 * workspace shell (sections: brief | instructions | quality | knowledge |
 * examples). Knowledge Base documents live on the `knowledge` pane; the page
 * keeps its "Living Memory" h1 on every view.
 */
export class LivingMemory {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Open the Knowledge pane that owns project Knowledge Base documents. */
  async openKnowledge(projectId: string): Promise<void> {
    await this.page.goto(`/project/${projectId}/memory/knowledge`)
    await expect(this.page.getByRole("heading", { name: "Living Memory" })).toBeVisible({ timeout: 10_000 })
    await expect(this.page.getByText("Knowledge base", { exact: true })).toBeVisible({ timeout: 10_000 })
  }

  /** Upload one Knowledge Base source document and wait for its server-returned row. */
  async uploadKnowledgeDocument(name: string, content: string): Promise<void> {
    const input = this.page.locator('input[type="file"][accept*=".md"]')
    await input.setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(content) })
    await expect(this.knowledgeDocumentCard(name)).toBeVisible({ timeout: 10_000 })
  }

  /** Open the server-extracted text for a Knowledge Base document. */
  async openKnowledgeDocument(name: string): Promise<Locator> {
    const card = this.knowledgeDocumentCard(name)
    await card.getByRole("button", { name: "View document" }).click()
    const dialog = this.page.getByRole("dialog", { name })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    return dialog
  }

  /** Delete a project-owned Knowledge Base document through its confirmation. */
  async deleteKnowledgeDocument(name: string): Promise<void> {
    const card = this.knowledgeDocumentCard(name)
    await card.getByRole("button", { name: "Delete document" }).click()
    const alert = this.page.getByRole("alertdialog")
    await expect(alert).toBeVisible({ timeout: 5_000 })
    await alert.getByRole("button", { name: "Delete document" }).click()
    await expect(card).not.toBeVisible({ timeout: 10_000 })
  }

  private knowledgeDocumentCard(name: string): Locator {
    return this.page.locator('[data-slot="card"]').filter({ hasText: name })
  }
}
