import { type Page, type Locator, expect } from "@playwright/test"

/**
 * Page object for the AQU-AGENT sandbox-agent journey: chat dock → Agent tab
 * → sandbox session with an attached fixture → streamed tool/code activity →
 * staged `PlanImport` changeset → `/approve/:changesetId` → memory proposal
 * review → human-edit protection.
 *
 * LOCATION (resolved, Wave 2): moved here into `e2e/helpers/page-objects/`
 * from the W1F-assigned `e2e/pages/agent-page.ts` so it matches every other
 * page object in the repo (AGENTS.md "Reuse helpers in
 * e2e/helpers/page-objects/"). The former SWARM-TODO on location is closed.
 *
 * SELECTORS (resolved, Wave 2): the run-timeline renderers now emit
 * `data-frame-type="<contract frame name>"` (CodeActivityBlock, ChangesetCard,
 * MemoryProposalNotice, BriefProposalNotice, BudgetMeter) and the memory rows
 * emit `data-memory-path="<path>"` (Proposed/ApprovedMemoryList), so the
 * selectors below resolve against the real components — mirroring this repo's
 * existing `data-cell-id` / `data-testid="lane-switcher"` convention.
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

  async startNewSession(): Promise<void> {
    await this.page.getByRole("button", { name: "New session" }).click()
    await expect(this.page.getByRole("region", { name: "Target pane" })).toBeVisible()
  }

  /** The full-screen contract: the document remains visible around the agent and
   * both dividers are keyboard-accessible separators. */
  async expectThreePaneWorkbench(): Promise<void> {
    const workspaceHeader = this.page.getByRole("banner")
    const toolbar = workspaceHeader.getByRole("group", { name: "Agent workbench toolbar" })
    await expect(toolbar.getByRole("tab", { name: "Sessions" })).toBeVisible()
    await expect(toolbar.getByRole("tab", { name: "Memory" })).toBeVisible()
    await expect(toolbar.getByRole("button", { name: "New session" })).toBeVisible()
    await expect(toolbar.getByRole("button", { name: "Close workbench" })).toHaveText("Editor")
    await expect(this.page.getByRole("main").getByRole("group", { name: "Agent workbench toolbar" })).toHaveCount(0)
    const location = workspaceHeader.getByRole("button", { name: "Inspect workspace location" })
    await expect(location).toBeVisible()
    await location.click()
    await expect(this.page.getByRole("navigation", { name: "Full workspace location" })).toBeVisible()
    await this.page.keyboard.press("Escape")
    await expect(this.page.getByRole("region", { name: "Source pane" })).toBeVisible()
    await expect(this.page.getByRole("region", { name: "Agent pane" })).toBeVisible()
    await expect(this.page.getByRole("region", { name: /Target (pane|review pane)/ })).toBeVisible()
    await expect(this.page.getByRole("separator", { name: /Resize .* panes/ })).toHaveCount(2)
  }

  /** The conversation owns a bounded viewport inside the middle pane. This
   * catches flex-height regressions where content is clipped by the panel and
   * wheel/trackpad input cannot move the agent timeline. */
  async expectAgentTimelineScrollable(): Promise<void> {
    const viewport = this.page.locator('[data-slot="message-scroller-viewport"]')
    await expect(viewport).toBeVisible()
    await expect.poll(
      () => viewport.evaluate((element) => element.scrollHeight > element.clientHeight),
      { timeout: 10_000 },
    ).toBe(true)

    const before = await viewport.evaluate((element) => element.scrollTop)
    await viewport.hover()
    await this.page.mouse.wheel(0, 400)
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(before)
  }

  /** Use the workbench context control as a file picker. Selection keeps the
   * `/agent` route and loads the same file into both document panes. */
  async chooseWorkbenchFile(nameSubstring: string): Promise<void> {
    await this.page.getByRole("button", { name: /(?:Choose|Change) agent file/ }).click()
    const file = this.page
      .locator("aside")
      .locator('[data-showcase="sidebar.file"]')
      .filter({ has: this.page.getByRole("button", { name: new RegExp(nameSubstring, "i") }) })
    await expect(file).toBeVisible()
    await file.click()
    await expect(this.page).toHaveURL(/\/agent$/)
  }

  async expectWorkbenchFile(fileName: RegExp, sourceText: string): Promise<void> {
    const source = this.page.getByRole("region", { name: "Source pane" })
    const target = this.page.getByRole("region", { name: "Target pane" })
    await expect(this.page.getByTestId("agent-workbench-file-name")).toHaveText(fileName, { timeout: 30_000 })
    await expect(this.page.getByRole("button", { name: "Change agent file" })).toHaveText("Change file")
    await expect(source.getByText(fileName)).toHaveCount(0)
    await expect(target.getByText(fileName)).toHaveCount(0)
    await expect(source.getByText(sourceText, { exact: false })).toBeVisible({ timeout: 30_000 })
  }

  /** Edit a committed target directly in the workbench using the same
   * TranslatedEditor surface and outbox path as the main translation grid. */
  async editFirstWorkbenchTarget(value: string): Promise<void> {
    const targetPane = this.page.getByRole("region", { name: "Target pane" })
    const target = targetPane.getByRole("textbox").first()
    await target.click()
    await expect(target).toHaveAttribute("contenteditable", "true")
    await target.fill(value)
    await target.press("Escape")
    await expect(targetPane.getByText(value, { exact: true })).toBeVisible({ timeout: 15_000 })
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
   *
   * The real affordance (AgentDockView, Wave 2): the composer's "Attach file"
   * button opens a hidden `input[type=file]`; choosing a file uploads it as a
   * project artifact via `POST /api/v2/projects/:id/agent-artifacts`, and an
   * attachment pill (`[data-attachment-id]`) appears once the upload lands.
   * The next prompt's run request carries `{artifactId, fileName}` so the
   * harness can `load_artifact` it into the sandbox.
   *
   * We set files directly on the hidden input (the robust Playwright pattern —
   * clicking the button would open a native file chooser), then wait for the
   * pill so the artifact id is registered before `sendPrompt`.
   */
  async attachFixture(filePath: string): Promise<void> {
    const fileInput = this.page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(filePath)
    // Upload is async — wait for the attachment pill that confirms it landed.
    await expect(this.page.locator("[data-attachment-id]").first()).toBeVisible({ timeout: 30_000 })
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

  /** Wait for a legacy staged-changeset card (`changeset.staged` frame)
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
