import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, addProjectMember, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")
const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

const CORRECTION = "house of-him corrected"

function syncWorkerOrigin(): string {
  const rawHost = process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"
  if (/^https?:\/\//.test(rawHost)) return rawHost.replace(/\/+$/, "")
  const host = rawHost.replace(/\/+$/, "")
  const protocol = /^(127\.|localhost|0\.0\.0\.0)/.test(host) ? "http" : "https"
  return `${protocol}://${host}`
}

/** The gloss as the server has it — the artifact the correction must become. */
async function persistedGloss(
  jwt: string,
  projectId: string,
  fileId: string,
  cellId: string,
  lane: string,
): Promise<string | null> {
  const tokenRes = await fetch(`${FRONTIER_BASE}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId, fileId }),
  })
  if (!tokenRes.ok) return null
  const { token } = (await tokenRes.json()) as { token?: string }
  if (!token) return null

  const res = await fetch(
    `${syncWorkerOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
      `/files/${encodeURIComponent(fileId)}/glosses?cellIds=${encodeURIComponent(cellId)}` +
      `&lane=${encodeURIComponent(lane)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return null
  const data = (await res.json()) as { glosses?: Array<{ cellId: string; glossText: string }> }
  return (data.glosses ?? []).find((g) => g.cellId === cellId)?.glossText ?? null
}

/**
 * AQU-1408 §1 — a corrected statistical gloss is a committed artifact other
 * members see.
 *
 * Why this is a smoke and the rest of the BT panel is RTL (AGENTS.md →
 * "Smoke is for cross-layer product lies only"): a contributor's correction is
 * work that can be silently lost. It travels SPA → outbox → sync-worker →
 * Postgres and comes back through a read route into a second member's browser,
 * and the failure mode this ticket exists to prevent is exactly the one §6 hit
 * before it — the click is accepted, nothing reaches the server, and the
 * correction is gone on reload with no error anywhere. Only a second browser
 * context against real workers can tell a correction that persisted from one
 * that merely rendered.
 *
 * This spec:
 *   1. Alice creates a project, imports sample.md, translates cell 0.
 *   2. Alice corrects the cell's statistical gloss from the BT tab.
 *   3. The glosses read route reports the correction (it is really on file).
 *   4. Bob, a CONTRIBUTOR, opens the same cell and reads Alice's correction.
 *   5. Carol, a REVIEWER, meets the correction affordance disabled *with its
 *      reason* rather than absent or live-but-inert.
 */
test("a corrected statistical gloss persists and reaches other members", async ({ alice, bob, carol }) => {
  test.setTimeout(150_000)
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.REVIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Gloss ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  const fileId = alice.url().match(/\/file\/([^/?#]+)/)?.[1]
  const firstCellId = await ws.cellRow(0).getAttribute("data-cell-id")
  expect(projectId).toBeTruthy()
  expect(fileId).toBeTruthy()
  expect(firstCellId).toBeTruthy()

  // A gloss reads a translation, so the cell needs one. It does NOT need a
  // corpus: the correction is offered even when the project has too few pairs
  // to compute a gloss, which is the state a fresh project is in.
  await ws.editCell(0, "Traduction pour le gloss")

  const openBtTab = async (page: typeof alice, workspace: Workspace) => {
    const row = workspace.cellRow(0)
    await row.scrollIntoViewIfNeeded()
    await row.hover()
    const expandBtn = row.getByRole("button", { name: /Open cell details/i })
    await expect(expandBtn).toBeVisible({ timeout: 8_000 })
    await expandBtn.click()
    const btTab = page.getByRole("button", { name: /back-translation/i })
      .or(page.getByRole("tab", { name: /back-translation/i }))
    await expect(btTab.first()).toBeVisible({ timeout: 5_000 })
    await btTab.first().click()
    return page.getByRole("tabpanel", { name: /back-translation/i })
  }

  const alicePanel = await openBtTab(alice, ws)
  const correctBtn = alicePanel.getByRole("button", { name: "Correct the statistical gloss" })
  await expect(correctBtn).toBeVisible({ timeout: 8_000 })
  await correctBtn.click()
  const editor = alicePanel.getByRole("textbox", { name: "Correct the statistical gloss" })
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.fill(CORRECTION)
  await alicePanel.getByRole("button", { name: /^Save$/ }).click()
  await expect(alicePanel).toContainText(CORRECTION, { timeout: 10_000 })
  // The reader must be able to tell a colleague's correction from the corpus's
  // own guess, so the label is part of the contract, not decoration.
  await expect(alicePanel).toContainText(/Corrected by a translator/i, { timeout: 10_000 })

  // On file at the server — the assertion that separates a persisted
  // correction from one that only rendered. The project's first target lane is
  // tagged "fr" (AQU-1594), so the read names it as the workspace does.
  await expect.poll(
    () => persistedGloss(aliceSession.jwt, projectId!, fileId!, firstCellId!, "fr"),
    { timeout: 30_000 },
  ).toBe(CORRECTION)

  // A second member reads it.
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)
  await bob.goto(`/project/${projectId}/editor`)
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()
  let bobPanel = await openBtTab(bob, bobWs)
  // Bob's workspace hydrates glosses once on file load, so his first fetch can
  // legitimately race Alice's outbox flush. Reload to re-run the hydration
  // rather than weakening the cross-user assertion.
  await expect(async () => {
    if (!(await bobPanel.getByText(CORRECTION).isVisible())) {
      await bob.reload()
      await bobWs.waitForEditor()
      bobPanel = await openBtTab(bob, bobWs)
      await expect(bobPanel.getByText(CORRECTION)).toBeVisible({ timeout: 2_000 })
    }
  }).toPass({ timeout: 40_000 })

  // Below contributor the control is present and disabled WITH its reason —
  // "Never disable silently" (09-design-and-ux.md). A button that takes a
  // click and drops it is the defect this ticket reports.
  await addProjectMember(aliceSession.jwt, projectId!, "carol", ROLE.REVIEWER)
  await carol.goto(`/project/${projectId}/editor`)
  const carolWs = new Workspace(carol)
  await carolWs.openFileBySubstring("sample")
  await carolWs.waitForEditor()
  const carolPanel = await openBtTab(carol, carolWs)
  const locked = carolPanel.getByLabel("Contributor+ required to correct the gloss")
  await expect(locked).toBeVisible({ timeout: 10_000 })
  await expect(locked).toBeDisabled()
})
