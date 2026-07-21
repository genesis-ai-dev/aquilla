import { test, expect } from "../helpers/multi-user"
import { Dashboard } from "../helpers/page-objects/Dashboard"
import { Workspace } from "../helpers/page-objects/Workspace"
import { AgentPage } from "../helpers/page-objects/AgentPage"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIXED_NOTES_CSV = path.resolve(__dirname, "../fixtures/agent/mixed-notes.csv")

/**
 * AQU-AGENT golden path: a translation org uploads a genuinely messy file
 * (see `e2e/fixtures/agent/README.md`) to a project's Agent tab, the sandbox
 * agent inspects/parses it (streamed code activity), stages a `PlanImport`
 * changeset (never writes raw events — see docs/AGENT-SANDBOX.md "write
 * path"), a human approves it at `/approve/:changesetId`, the run proposes a
 * living-memory entry from what it learned, a human approves that too, and
 * finally we verify human-edit protection: once a human edits an approved
 * memory, the agent-facing UI marks it protected.
 *
 * Skipped outside the AQU-AGENT sandbox stack (agent-worker + harness tools +
 * memory API are being built in parallel by W1A/W1B/W1C; this spec is the
 * structural skeleton Wave 2's UI verifier wires up and un-skips once the
 * stack is live end-to-end). Run manually with
 * `AGENT_SANDBOX_E2E=1 npx tsx scripts/e2e-up.ts -- agent-import` once ready.
 */
test.skip(
  !process.env.AGENT_SANDBOX_E2E,
  "requires the AQU-AGENT sandbox stack (agent-worker + harness tools); set AGENT_SANDBOX_E2E=1 once Wave 2 wires it up",
)

test("agent session imports a messy CSV via a staged PlanImport changeset, proposes memory, and human edits are protected", async ({
  alice,
}) => {
  test.setTimeout(180_000)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Agent Import ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "am" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.waitForEditor().catch(() => {
    // Fresh project may show the empty-state / setup checklist instead of a
    // hydrated editor — the Agent tab is reachable from either state.
  })

  const agent = new AgentPage(alice)
  await agent.openAgentTab()

  // Attach the deliberately messy fixture and ask the agent to import it.
  await agent.attachFixture(MIXED_NOTES_CSV)
  await agent.sendPrompt(
    "Import mixed-notes.csv. It's messy — check for a merged header row, mixed delimiters, and rows where source/target look swapped before staging anything.",
  )

  // Streamed code activity (contract `tool.code.start`/`tool.code.output`):
  // the agent should actually run inspection code in the sandbox, not just
  // narrate what it would do.
  await agent.waitForCodeActivity()

  // Staged changeset card — nothing is written to the project yet (ask-mode
  // credential per changeset-bridge, contracts §2).
  const { approvalUrl } = await agent.waitForStagedChangeset()
  expect(approvalUrl).toMatch(/\/approve\//)

  // Human approves at /approve/:changesetId (existing Agent API surface —
  // src/pages/ApproveChangeset/ApproveChangeset.tsx).
  await agent.approveChangeset(approvalUrl)

  // Back in the workbench, the run should propose at least one memory entry
  // capturing what it learned from the messy import (e.g. the swapped
  // source/target convention in this project's uploads).
  await alice.goto(`/project/${await currentProjectId(alice)}/agent`)
  await agent.waitForMemoryProposal()
  await agent.openMemoryTab()

  const proposedPath = "observations/mixed-notes-import.md"
  await agent.approveMemory(proposedPath)

  // Human-edit protection: a human edits the now-approved memory, and the
  // agent-facing badge flips to "human edited" — per contracts §3, the
  // agent channel can no longer PATCH this row (403 human_edit_protected).
  await agent.editApprovedMemory(
    proposedPath,
    "Source/target columns in this org's exports are occasionally swapped — always confirm language direction before importing.",
  )
  await agent.expectHumanEditedBadge(proposedPath)
})

async function currentProjectId(page: import("@playwright/test").Page): Promise<string> {
  const match = page.url().match(/\/project\/([^/?#]+)/)
  if (!match) throw new Error(`could not read project id from URL: ${page.url()}`)
  return decodeURIComponent(match[1])
}
