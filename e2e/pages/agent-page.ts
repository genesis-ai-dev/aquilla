import { type Page, type Locator, expect } from "@playwright/test"

/**
 * Page object for the AQU-AGENT sandbox-agent journey: chat dock → Agent tab
 * → sandbox session with an attached fixture → streamed tool/code activity →
 * staged `PlanImport` changeset → `/approve/:changesetId` → memory proposal
 * review → human-edit protection.
 *
 * NOTE on location: every other page object in this repo lives under
 * `e2e/helpers/page-objects/` (see `e2e/helpers/page-objects/Workspace.ts`).
 * This file lives at `e2e/pages/agent-page.ts` per the explicit AQU-AGENT
 * swarm task assignment (W1F). That's a real deviation from the codebase's
 * own page-object convention (AGENTS.md "Reuse helpers in
 * e2e/helpers/page-objects/") — flagged per CLAUDE.md Rule 11 rather than
 * silently forked. SWARM-TODO(aqu-agent): Wave 2 integrator should decide
 * whether to move this into `e2e/helpers/page-objects/AgentPage.ts` for
 * consistency, or keep `e2e/pages/` as a deliberate new convention for
 * full-screen-route page objects (this journey is largely the
 * `/project/:id/agent` full-screen workbench, not the docked chat panel).
 *
 * NOTE on selectors: `docs/swarm/AQU-AGENT-CONTRACTS.md` §4 defines NEW SSE
 * frame types (`tool.code.start`, `tool.code.output`, `changeset.staged`,
 * `memory.proposed`, `brief.proposed`, `budget`, `budget.exhausted`) that
 * W1D/W1E render into the DOM. Those components don't exist yet at the time
 * this file was written (W1F runs in parallel with W1D/W1B/W1C). Selectors
 * below therefore lead with resilient, spec-shaped fallbacks (role/text) and
 * a documented `data-frame-type` attribute convention mirroring the contract
 * frame names 1:1 (e.g. `[data-frame-type="changeset.staged"]`) — Wave 2's
 * UI verifier should either (a) confirm the real components already emit
 * `data-frame-type` on their run-timeline rows and this file's selectors
 * "just work," or (b) add that attribute to the new frame renderers so this
 * file's selectors resolve without edits, matching the existing convention
 * of `data-cell-id` / `data-cell-type` / `data-testid="lane-switcher"` etc.
 * seen elsewhere in this repo's components (see Workspace.ts).
 */
export class AgentPage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // ── Entry ──────────────────────────────────────────────────────────────

  /** Open the docked "Agent" tab from within an already-open project workspace. */
  async openAgentTab(): Promise<void> {
    await this.page.getByRole("button", { name: "Agent", exact: true }).click()
  }

  /** Expand the docked agent panel into the full-screen workbench at
   * `/project/:id/agent`. Mirrors `agent-draft.spec.ts`'s existing pattern. */
  async openFullScreenWorkbench(): Promise<void> {
    await this.page.getByRole("button", { name: "Open full-screen workbench" }).click()
    await expect(this.page).toHaveURL(/\/agent$/)
  }

  async closeFullScreenWorkbench(): Promise<void> {
    await this.page.getByRole("button", { name: "Close workbench" }).click()
  }

  // ── Session + attachment ──────────────────────────────────────────────

  /** Type a prompt into the agent composer and submit it. Shared by both
   * the docked panel and the full-screen workbench (same composer role). */
  async sendPrompt(prompt: string): Promise<void> {
    const composer = this.page.getByRole("textbox", { name: "Ask the agent" })
    await composer.click()
    await composer.pressSequentially(prompt)
    await this.page.keyboard.press("Enter")
  }

  /**
   * Attach a fixture file to the session before sending the prompt.
   * SWARM-TODO(aqu-agent): the harness's `load_artifact` tool (contracts §2)
   * resolves an artifact already uploaded to the project (R2-backed), not a
   * raw local-filesystem attach — so "attach a fixture" in the real UI is
   * likely "upload the fixture as a project artifact first, then reference
   * it," not a literal file-input drop on the composer. This method's
   * `input[type=file]` guess is a placeholder pending W1D's composer
   * attachment affordance; adjust once that UI lands (see AgentDockView.tsx
   * / the composer's `SuggestedAction`/attachment props).
   */
  async attachFixture(filePath: string): Promise<void> {
    const attachButton = this.page.getByRole("button", { name: /Attach file|Add attachment/i })
    if (await attachButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await attachButton.click()
    }
    const fileInput = this.page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(filePath)
  }

  // ── Streamed activity ──────────────────────────────────────────────────

  /** Assert at least one code-activity frame (contract `tool.code.start` /
   * `tool.code.output`) rendered in the run timeline. */
  async waitForCodeActivity(): Promise<void> {
    const codeFrame = this.page
      .locator('[data-frame-type="tool.code.start"], [data-frame-type="tool.code.output"]')
      .first()
    await expect(codeFrame).toBeVisible({ timeout: 30_000 })
  }

  // ── Changeset staging + approval ───────────────────────────────────────

  /** Wait for the staged-changeset card (contract `changeset.staged` frame)
   * and return its approval URL (from the card's link href, or by reading
   * the run timeline text if the card doesn't expose an anchor). */
  async waitForStagedChangeset(): Promise<{ approvalUrl: string; card: Locator }> {
    const card = this.page.locator('[data-frame-type="changeset.staged"]').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    const link = card.getByRole("link", { name: /Review|Approve/i })
    const href = await link.getAttribute("href")
    if (!href) throw new Error("staged-changeset card has no approval link href")
    return { approvalUrl: href, card }
  }

  /** Navigate to `/approve/:changesetId` and approve. Mirrors
   * `ApproveChangeset.tsx`'s "Approve" button (see
   * `src/pages/ApproveChangeset/ApproveChangeset.tsx`). */
  async approveChangeset(approvalUrl: string): Promise<void> {
    await this.page.goto(approvalUrl)
    const approveBtn = this.page.getByRole("button", { name: "Approve", exact: true })
    await expect(approveBtn).toBeVisible({ timeout: 10_000 })
    await approveBtn.click()
    await expect(this.page.getByText(/Approved/i)).toBeVisible({ timeout: 10_000 })
  }

  async rejectChangeset(approvalUrl: string): Promise<void> {
    await this.page.goto(approvalUrl)
    const rejectBtn = this.page.getByRole("button", { name: "Reject", exact: true })
    await expect(rejectBtn).toBeVisible({ timeout: 10_000 })
    await rejectBtn.click()
    await expect(this.page.getByText(/Rejected/i)).toBeVisible({ timeout: 10_000 })
  }

  // ── Memory proposals (W1E's AgentMemoryTab, contracts §3 + §5) ─────────

  /** Wait for a `memory.proposed` frame toast/card in the run timeline. */
  async waitForMemoryProposal(): Promise<Locator> {
    const proposal = this.page.locator('[data-frame-type="memory.proposed"]').first()
    await expect(proposal).toBeVisible({ timeout: 30_000 })
    return proposal
  }

  /** Switch the workbench's tab slot to "memory" — contracts §5: AgentWorkbench
   * adds a `sessions | memory` tab slot, memory tab lazy-imports
   * W1E's `AgentMemoryTab`. */
  async openMemoryTab(): Promise<void> {
    await this.page.getByRole("tab", { name: "Memory" }).click()
  }

  /** Approve a proposed-memory row by its path (e.g. "observations/foo.md"). */
  async approveMemory(path: string): Promise<void> {
    const row = this.memoryRow(path)
    await row.getByRole("button", { name: "Approve", exact: true }).click()
    await expect(row.getByText(/Approved/i)).toBeVisible({ timeout: 10_000 })
  }

  /** Human-edit an approved memory's content via the AgentMemoryTab editor
   * (PATCH per contracts §3 — sets `human_edited=true`). */
  async editApprovedMemory(path: string, newContent: string): Promise<void> {
    const row = this.memoryRow(path)
    await row.getByRole("button", { name: /Edit/i }).click()
    const editor = this.page.getByRole("textbox", { name: /memory content/i })
    await editor.fill(newContent)
    await this.page.getByRole("button", { name: /Save/i }).click()
  }

  /** Assert the "human edited" badge is visible for a memory row — the
   * agent-facing signal that this content is now protected (contracts §3:
   * agent-channel PATCH to a human-edited row → 403 `human_edit_protected`). */
  async expectHumanEditedBadge(path: string): Promise<void> {
    await expect(this.memoryRow(path).getByText(/Human.?edited/i)).toBeVisible({ timeout: 10_000 })
  }

  private memoryRow(path: string): Locator {
    return this.page.locator(`[data-memory-path="${path}"]`)
  }

  // ── Budget ───────────────────────────────────────────────────────────

  /** Assert the run halted gracefully at the cost cap (contract
   * `budget.exhausted` frame). */
  async expectBudgetExhausted(): Promise<void> {
    await expect(this.page.locator('[data-frame-type="budget.exhausted"]').first()).toBeVisible({
      timeout: 30_000,
    })
  }
}
