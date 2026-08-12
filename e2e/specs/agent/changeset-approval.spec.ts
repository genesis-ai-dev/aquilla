import { test, expect } from "../../helpers/multi-user"
import { AgentPage } from "../../helpers/page-objects/AgentPage"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import {
  commitChangeset,
  mintApiCredential,
  stageSetTranslationChangeset,
} from "../../helpers/agent-api"

/**
 * Agent-changeset approval journey (AQU-533 §3 "ask-mode confirmation:
 * enforced, not requested"):
 *
 *   external agent stages a SetTranslation changeset over the Agent API
 *   (aqk_ credential) → commit is REFUSED until a human approves → the human
 *   approves in the app → the agent commits → the translation lands in the
 *   editor through the normal /events projection.
 *
 * Two approval surfaces are covered:
 *   1. the standalone `/approve/:changesetId` page (the deep link the API
 *      hands the agent), and
 *   2. the in-chat ChangesetCard in the agent dock — rendered from a persisted
 *      agent session (its production data source: `changeset.staged` frames of
 *      persisted runs, rehydrated from localStorage by session-store.ts), whose
 *      status badge tracks the changeset live by polling the approval endpoint.
 *
 * WHY these assertions: the approval gate is the product's core safety
 * property for external agents — a commit that succeeds without a consumed
 * human confirmation, or an approval that doesn't unlock the commit, is a
 * security regression, not a cosmetic bug.
 */

test.describe("agent changeset approval", () => {
  test("ask-mode commit is gated on the /approve page; approval unlocks it and the cell updates", async ({
    alice,
  }) => {
    // Multi-service journey (auth-worker mint + sync-worker stage/commit +
    // SPA approval + editor verify); cold dev-server compiles of two routes
    // can push past the 60s default ceiling on slower machines.
    test.setTimeout(120_000)

    const jwt = await jwtFor("alice")
    const seeded = await seedProjectWithFile(jwt, { name: `Agent approve ${Date.now()}` })
    const { token } = await mintApiCredential(jwt, {
      mode: "ask",
      projectId: seeded.projectId,
    })

    const value = "Approved-page agent translation"
    const staged = await stageSetTranslationChangeset(token, seeded.projectId, [
      { fileId: seeded.fileId, cellId: seeded.cellIds[0], value },
    ])
    expect(staged.changeset.status).toBe("staged")
    expect(staged.summary.translationsAdded).toBe(1)

    // The gate itself: an ask-mode commit WITHOUT a human approval must be
    // refused with 428 confirmation_required — and must not apply anything.
    const premature = await commitChangeset(token, seeded.projectId, staged.changeset.id)
    expect(premature.status).toBe(428)
    expect(premature.error?.code).toBe("confirmation_required")

    // Human approves on the standalone approval page. The page renders the
    // server-computed effect summary (never a client-recomputed one), so the
    // human sees what they are authorizing before clicking Approve.
    const approvalPath = `/approve/${staged.changeset.id}`
    await alice.goto(approvalPath)
    await expect(alice.getByText("Approve agent changes")).toBeVisible({ timeout: 30_000 })
    await expect(alice.getByText(seeded.projectName)).toBeVisible()
    await expect(alice.getByText("What will be applied")).toBeVisible()
    await expect(alice.getByText(/Translations added/i)).toBeVisible()

    const agentPage = new AgentPage(alice)
    await agentPage.approveChangeset(approvalPath)

    // The consumed approval unlocks exactly this plan.
    const committed = await commitChangeset(token, seeded.projectId, staged.changeset.id)
    expect(committed.status).toBe(200)
    expect(committed.receipt?.appliedCount).toBe(1)
    expect(committed.receipt?.staleCount).toBe(0)

    // The translation reached the projection: the editor shows it in the
    // first cell's target.
    const ws = await openSeededProject(alice, seeded)
    await expect(ws.cellRow(0)).toContainText(value, { timeout: 15_000 })
  })

  test("in-chat ChangesetCard links to approval and its badge tracks the commit", async ({
    alice,
  }) => {
    test.setTimeout(120_000)

    const jwt = await jwtFor("alice")
    const seeded = await seedProjectWithFile(jwt, { name: `Agent card ${Date.now()}` })
    const { token } = await mintApiCredential(jwt, {
      mode: "ask",
      projectId: seeded.projectId,
    })

    const value = "In-chat approved agent translation"
    const staged = await stageSetTranslationChangeset(token, seeded.projectId, [
      { fileId: seeded.fileId, cellId: seeded.cellIds[0], value },
    ])
    const approvalPath = `/approve/${staged.changeset.id}`

    // Seed the persisted agent session the dock rehydrates from localStorage
    // (session-store.ts PersistedSession) with a settled run whose timeline
    // carries the staged changeset — the production data source for the
    // in-chat ChangesetCard. The card then polls the real approval endpoint,
    // so everything it displays past this point is live server state.
    await alice.context().addInitScript(
      ({ key, session }) => {
        localStorage.setItem(key, session)
      },
      {
        key: `aquilla:agent-session:v1:${seeded.projectId}`,
        session: JSON.stringify({
          sessionId: crypto.randomUUID(),
          runs: [
            {
              localId: "run-e2e-1",
              prompt: "Stage a translation for the first cell",
              runId: "e2e-run-1",
              items: [
                {
                  id: "i0",
                  kind: "changeset",
                  changesetId: staged.changeset.id,
                  approvalUrl: approvalPath,
                  summary: "Set 1 translation",
                  cellCount: 1,
                },
              ],
              status: "ok",
            },
          ],
          decided: [],
          activity: [],
        }),
      },
    )

    const ws = await openSeededProject(alice, seeded)

    const agentPage = new AgentPage(alice)
    await agentPage.openAgentTab()

    // The card is pending and links to the approval page.
    const { approvalUrl, card } = await agentPage.waitForStagedChangeset()
    expect(approvalUrl).toBe(approvalPath)
    await expect(card).toHaveAttribute("data-changeset-status", "staged")
    await expect(card.getByText("Pending review")).toBeVisible()

    // "Review & approve" opens the approval page in a new tab; approve there.
    const [popup] = await Promise.all([
      alice.waitForEvent("popup"),
      card.getByRole("link", { name: /Review & approve/ }).click(),
    ])
    await new AgentPage(popup).approveChangeset(approvalPath)
    await popup.close()

    // Agent commits with the consumed approval.
    const committed = await commitChangeset(token, seeded.projectId, staged.changeset.id)
    expect(committed.status).toBe(200)
    expect(committed.receipt?.appliedCount).toBe(1)

    // The card's poll observes the terminal state without a reload.
    await expect(card).toHaveAttribute("data-changeset-status", "committed", {
      timeout: 15_000,
    })
    await expect(card.getByText("Committed")).toBeVisible()

    // And the translation is really in the editor. A reload is required by
    // design: the commit's `event.applied` frame carries `by: alice` (the
    // credential's owner), and ws-reconciler's isOwnWriteEcho skips the
    // refetch for the author's own client — so the still-open editor does not
    // live-refresh on an agent commit made under the viewer's identity.
    await alice.reload()
    await ws.waitForEditor(seeded.cellIds[0])
    await expect(ws.cellRow(0)).toContainText(value, { timeout: 15_000 })
  })
})
