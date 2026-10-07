/**
 * AQU-1039 — a contributor staffed on one lane only works in that lane.
 *
 * Full journey, not a smoke test. Alice owns the project. Bob is an org
 * member she staffs as a contributor on the second lane only.
 *
 *   1. Alice translates her first lane (fr), then adds a second lane.
 *   2. She staffs Bob on that lane from the project overview.
 *   3. Bob's switcher offers only that lane, and settings plus the cells
 *      read do too.
 *   4. A commit and a validation aimed at Alice's lane are rejected.
 *      The staffed lane accepts a translation and a validation.
 *   5. The two lanes keep their own text and validation. A source edit is
 *      shared, and each lane's existing translation goes stale on its own.
 *
 * AQU-1594: a new project's first target lane is tagged with its language
 * ("fr"), not the blank default tag, and a lane added from Languages is a lane
 * row only — it is not mirrored into `settings.targetLanes`.
 */

import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { addOrgMember, readProjectLanes, readProjectSettings, ROLE } from "../../helpers/frontier-api"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, mintSyncToken, readProjectedCells } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")
const SYNC_BASE = process.env.E2E_SYNC_BASE
  ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

test("a member staffed on one lane cannot see or write the other", async ({ alice, bob }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const frenchText = `Bonjour lane A ${stamp}`
  const spanishText = `Hola lane B ${stamp}`
  const forgedText = `forged lane A ${stamp}`
  const nextSource = `Source moved ${stamp}`

  await addOrgMember(await jwtFor("alice"), alice.orgId, "bob", ROLE.CONTRIBUTOR)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `LaneScope ${stamp}`
  await dash.createProject({ name, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/?#]+)/)?.[1]
  if (!projectId) throw new Error(`no project id in ${alice.url()}`)
  await dash.openProject(name)

  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()
  await aliceWs.editCell(0, frenchText)
  await expect(aliceWs.cellRow(0)).toContainText(frenchText, { timeout: 5_000 })
  const fileId = alice.url().match(/\/file\/([^/?#]+)/)?.[1]
  if (!fileId) throw new Error(`no file id in ${alice.url()}`)

  const settings = new ProjectSettings(alice)
  await settings.openSettings()
  await settings.addTargetLanguage("es")
  await alice.goto(`/projects/${projectId}`)

  const esRow = alice.getByTestId("overview-lane-row-es")
  await expect(esRow).toBeVisible({ timeout: 15_000 })
  // The languages table re-renders while the portfolio is loading, which
  // detaches the open menu before Playwright's stability check can click it.
  // Prove Staff… is there, then activate that same item.
  const popover = alice.getByTestId("staff-lane-popover")
  await expect(async () => {
    await esRow.hover()
    await alice.getByTestId("overview-lane-actions-es").click()
    const staff = alice.getByRole("menuitem", { name: "Staff…" })
    await expect(staff).toBeVisible({ timeout: 2_000 })
    await staff.evaluate((el: HTMLElement) => el.click())
    await expect(popover).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await popover.getByLabel("Search org members").fill("bob")
  await popover.getByRole("button", { name: /^bob$/i }).click()
  await pickSelectOption(alice, popover.getByRole("combobox", { name: "Role" }), /^contributor/i)
  await popover.getByRole("button", { name: /^Add to / }).click()
  // Confirming refreshes the roster and remounts the popover, so the
  // "is now…" line does not stay. The lane's people cell is the record.
  await expect(esRow.getByText("BO", { exact: true })).toBeVisible({ timeout: 15_000 })

  await bob.goto(`/project/${projectId}/editor/file/${fileId}`)
  const bobWs = new Workspace(bob)
  await bobWs.waitForEditor()
  expect(await bobWs.readActiveLane()).toBe("es")
  await expect(bobWs.laneSwitcher()).toBeVisible()
  await bobWs.laneSwitcher().click()
  await expect(bob.getByTestId("lane-option-es")).toBeVisible()
  await expect(bob.getByTestId("lane-option-fr")).toHaveCount(0)
  await expect(bob.getByTestId("add-lane")).toHaveCount(0)
  await bob.keyboard.press("Escape")
  await expect(bobWs.cellRow(0)).not.toContainText(frenchText)

  const bobJwt = await jwtFor("bob")
  const aliceJwt = await jwtFor("alice")
  const bobSettings = await readProjectSettings(bobJwt, projectId)
  const aliceSettings = await readProjectSettings(aliceJwt, projectId)
  expect(aliceSettings.targetLanguage).toBe("fr")
  expect(bobSettings.targetLanguage ?? "").toBe("")
  // The lane rows are the registry (AQU-1594), so Bob's lane is checked there
  // below. The settings blob must still not hand him Alice's lane.
  const bobLaneLabels = Array.isArray(bobSettings.targetLanes) ? bobSettings.targetLanes : []
  expect(bobLaneLabels).not.toContain("fr")
  const bobTargets = (await readProjectLanes(bobJwt, projectId)).filter((lane) => lane.role === "target")
  expect(bobTargets.length).toBeGreaterThan(0)
  expect(bobTargets.every((lane) => (lane.legacyTag ?? "") === "es")).toBe(true)

  const bobToken = await mintSyncToken(bobJwt, projectId, fileId)
  const cellsRes = await fetch(
    `${SYNC_BASE}/api/v1/projects/${projectId}/files/${fileId}/cells`,
    { headers: { Authorization: `Bearer ${bobToken}` } },
  )
  expect(cellsRes.status).toBe(200)
  const bobCells = ((await cellsRes.json()) as { cells: Array<{ side: string; value: string; targetLang: string }> }).cells
  expect(bobCells.some((cell) => cell.side === "source")).toBe(true)
  expect(bobCells.some((cell) => cell.value.includes(frenchText))).toBe(false)
  expect(bobCells.filter((cell) => cell.side === "target").every((cell) => cell.targetLang === "es")).toBe(true)

  const cellId = (await readProjectedCells(aliceJwt, { projectId, fileId }, "target"))[0]?.cellId
  if (!cellId) throw new Error("no projected target cell")
  const rejected = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({
      events: [
        {
          id: randomUUID(),
          schemaVersion: 1,
          projectId,
          fileId,
          cellId,
          parentId: randomUUID(),
          kind: "target.cell.commit",
          author: "bob",
          payload: { value: forgedText, targetLang: "fr" },
          clientTs: Date.now(),
        },
        {
          id: randomUUID(),
          schemaVersion: 1,
          projectId,
          fileId,
          cellId,
          parentId: randomUUID(),
          kind: "cell.validate",
          author: "bob",
          payload: { targetLang: "fr" },
          clientTs: Date.now(),
        },
      ],
    }),
  })
  expect(rejected.status, await rejected.clone().text()).toBe(200)
  const rejectedBody = (await rejected.json()) as {
    accepted?: unknown[]
    rejected?: Array<{ status: number; reason?: string }>
  }
  expect(rejectedBody.accepted ?? []).toEqual([])
  expect(rejectedBody.rejected?.map((item) => item.status)).toEqual([403, 403])

  await bobWs.editCell(0, spanishText)
  await expect(bobWs.cellRow(0)).toContainText(spanishText, { timeout: 5_000 })
  await bobWs.validateCell(0)
  await bob.reload()
  await bobWs.waitForEditor()
  await expect(bobWs.cellRow(0)).toContainText(spanishText, { timeout: 10_000 })
  await expect(bobWs.cellRow(0)).not.toContainText(frenchText)

  await alice.goto(`/project/${projectId}/editor/file/${fileId}`)
  await aliceWs.waitForEditor()
  if ((await aliceWs.readActiveLane()) !== "fr") await aliceWs.switchLane("fr")
  await expect(aliceWs.cellRow(0)).toContainText(frenchText, { timeout: 10_000 })
  expect(await aliceWs.readTargetText(0)).not.toContain(spanishText)
  // Alice's own translation auto-validates on commit. Bob's validation of the
  // other lane must not be what this button is reporting, and it must not
  // count as Alice's validation once she switches.
  const aliceValidation = aliceWs.cellRow(0).getByRole("button", { name: /Validate|Validated/i }).first()
  await aliceWs.cellRow(0).hover()
  await expect(aliceValidation).toHaveAttribute("aria-pressed", "true")
  await expect(aliceValidation).toHaveAttribute("aria-label", /Validated by you/i)
  await aliceWs.switchLane("es")
  await expect(aliceWs.cellRow(0)).toContainText(spanishText, { timeout: 10_000 })
  expect(await aliceWs.readTargetText(0)).not.toContain(frenchText)
  const esValidation = aliceWs.cellRow(0).getByRole("button", { name: /Validate|Validated/i }).first()
  await aliceWs.cellRow(0).hover()
  await expect(esValidation).toHaveAttribute("aria-pressed", "false")

  const sourceRow = aliceWs.cellRow(0)
  await sourceRow.hover()
  await sourceRow.getByRole("button", { name: "Cell actions" }).click()
  await alice.getByTestId("cell-menu-edit-source").click()
  const sourceEditor = alice.getByRole("textbox", { name: "Edit source text" })
  await sourceEditor.fill(nextSource)
  await sourceEditor.blur()
  await expect(aliceWs.cellRow(0)).toContainText(nextSource, { timeout: 10_000 })
  await expect(aliceWs.cellRow(0).getByTestId("stale-source-indicator")).toBeVisible({ timeout: 10_000 })
  await aliceWs.switchLane("fr")
  await expect(aliceWs.cellRow(0)).toContainText(nextSource, { timeout: 10_000 })
  await expect(aliceWs.cellRow(0)).toContainText(frenchText)
  await expect(aliceWs.cellRow(0).getByTestId("stale-source-indicator")).toBeVisible({ timeout: 10_000 })

  await bob.reload()
  await bobWs.waitForEditor()
  await expect(bobWs.cellRow(0)).toContainText(nextSource, { timeout: 15_000 })
  await expect(bobWs.cellRow(0)).toContainText(spanishText)
  await expect(bobWs.cellRow(0).getByTestId("stale-source-indicator")).toBeVisible({ timeout: 10_000 })
  await expect(bobWs.cellRow(0)).not.toContainText(frenchText)
})
