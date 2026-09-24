import { randomUUID } from "node:crypto"
import type { Browser, Page, TestInfo } from "@playwright/test"
import { ROLE } from "../../e2e/helpers/frontier-api"
import type { PersistedSession } from "../../e2e/helpers/auth"
import { authenticatedPage, editorUrl, targetSurface, validationButton } from "../fixture"
import { runJev, JEV_REVISION, type AgentAction, type AgentRun } from "../driver"
import type { Attack, GoalContext, Ids } from "./attacks"
import { fingerprint } from "./fingerprint"
import { seedFor } from "./fuzz"
import { verifyInvariants, type AdversarialOutcome, type Contract, type Snapshot } from "./invariants"
import { createMutator } from "./mutators"
import { readRunContext, readSnapshot, seedFixture } from "./state"

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the agent must visibly have attempted, derived from the contract itself. */
async function sawIntendedInput(page: Page, attack: Attack, contract: Contract, action: AgentAction): Promise<boolean> {
  if (attack.observe === "any-action") return ["click", "fill", "select"].includes(action.kind)
  if (attack.observe === "pressed") {
    if (action.kind !== "click") return false
    for (const req of contract.required) {
      if (req.kind !== "validated" && req.kind !== "no-duplicate-validation") continue
      if (await validationButton(page, req.cellId).getAttribute("aria-pressed").catch(() => null) === "true") return true
    }
    return false
  }
  if (action.kind !== "fill") return false
  if (attack.observe === "target-text") {
    for (const req of contract.required) {
      const pairs = req.kind === "target-value" ? req.oneOf.map((value) => [req.cellId, value])
        : req.kind === "any-target-value" ? req.cellIds.map((cellId) => [cellId, req.value]) : []
      for (const [cellId, value] of pairs) {
        const text = await page.locator(`[data-cell-id="${cellId}"]`).first().innerText().catch(() => "")
        if (text.includes(value)) return true
      }
    }
    return false
  }
  // input-value: read the DOM, never the policy's own report of what it typed.
  const wanted = contract.required.flatMap((req) => req.kind === "project-name" || req.kind === "file-name"
    ? [req.value] : req.kind === "comment-once" ? [req.body] : [])
  return await page.locator("input, textarea").evaluateAll((elements, values) => elements.some((element) =>
    values.includes((element as HTMLInputElement).value)), wanted)
}

function countErrors(page: Page, counters: { server: number; page: number }) {
  page.on("pageerror", () => { counters.page++ })
  page.on("response", (response) => { if (response.status() >= 500) counters.server++ })
}

/** Run one attack end to end and attach allowlisted evidence. Returns the verdict. */
export async function runAttack(browser: Browser, attack: Attack, repeat: number, testInfo: TestInfo) {
  const run = readRunContext()
  const [primary, second, owner] = run.sessions
  const tag = randomUUID().slice(0, 6)
  const mainOwner = attack.fixture === "viewer" ? owner : primary
  const members = [
    ...(attack.fixture === "viewer" ? [{ username: primary.username, role: ROLE.VIEWER }] : []),
    ...(attack.secondRole ? [{ username: second.username, role: attack.secondRole }] : []),
  ]
  const main = await seedFixture(mainOwner, {
    name: `adv ${attack.id} ${tag}`, orgId: attack.fixture === "viewer" ? undefined : run.orgId, members,
  })
  const decoy = attack.decoy ? await seedFixture(owner, {
    name: `adv decoy ${tag}`, members: [{ username: primary.username, role: ROLE.VIEWER }],
  }) : null
  const readers: { projectId: string; reader: PersistedSession }[] = [
    { projectId: main.seeded.projectId, reader: mainOwner },
    ...(decoy ? [{ projectId: decoy.seeded.projectId, reader: owner }] : []),
  ]
  const ctx: GoalContext = {
    projectName: main.seeded.projectName, fileName: main.seeded.fileName, rows: main.rows,
    expected: `Adversarial ${tag} one`, expected2: `Adversarial ${tag} two`,
    decoyProjectName: decoy?.seeded.projectName ?? "", decoyFileName: decoy?.seeded.fileName ?? "",
    seed: seedFor(run.runId, attack.id, String(repeat)),
  }
  const ids: Ids = {
    projectId: main.seeded.projectId, fileId: main.seeded.fileId, cellIds: main.seeded.cellIds,
    decoyProjectId: decoy?.seeded.projectId ?? "", decoyCellIds: decoy?.seeded.cellIds ?? [],
    users: [primary.username, second.username],
  }
  const contract = attack.contract(ids, ctx)
  const goal = attack.goal(ctx)
  const secondGoal = attack.secondGoal?.(ctx) ?? null
  const before = await readSnapshot(readers)
  const counters = { server: 0, page: 0 }
  const mutator = createMutator(attack.mutator)
  const editorPath = editorUrl(main.seeded)
  const startPath = attack.journey === "project-rename" || attack.decoy ? "/app" : editorPath
  const agents: (AgentRun | null)[] = [null, null]
  const observed = [false, secondGoal === null]
  let after: Snapshot
  let outcome: AdversarialOutcome
  let error: string | null = null
  const primaryPage = await authenticatedPage(browser, primary, main.seeded)
  const secondPage = secondGoal ? await authenticatedPage(browser, second, main.seeded) : null
  const handle = { page: primaryPage.page, context: primaryPage.context, editorPath }
  try {
    for (const entry of [primaryPage, secondPage]) {
      if (!entry) continue
      countErrors(entry.page, counters)
      await entry.page.goto(startPath)
      if (startPath === editorPath) {
        await targetSurface(entry.page, main.seeded.cellIds[0]).waitFor({ state: "visible", timeout: 30_000 })
      }
    }
    await mutator.setup(handle)
    const drive = (index: number, page: Page, text: string) => runJev(page, text, {
      onEvidence: (value) => { agents[index] = value },
      onAction: async (action) => {
        if (observed[index] || !await sawIntendedInput(page, attack, contract, action)) return false
        observed[index] = true
        return index === 0 ? (await mutator.onInput(handle)).stop : false
      },
    })
    await Promise.all([
      drive(0, primaryPage.page, goal),
      ...(secondPage && secondGoal ? [drive(1, secondPage.page, secondGoal)] : []),
    ])
    await mutator.recover(handle)
    // Poll authoritative state briefly; expiry records the failed contract.
    const deadline = Date.now() + 15_000
    const observedNow = () => ({ inputObserved: observed.every(Boolean), mutatorApplied: mutator.applied,
      serverErrors: counters.server, pageErrors: counters.page })
    do {
      after = await readSnapshot(readers)
      outcome = verifyInvariants(before, after, contract, observedNow())
      if (outcome.verdict === "passed") break
      await settle(1_000)
    } while (observedNow().inputObserved && Date.now() < deadline)
    outcome = await confirmInFreshSession(browser, primary, main.seeded, contract, after, outcome)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    outcome = { verdict: "inconclusive", checks: {}, diffs: [], unmet: [],
      reason: `The run did not complete: ${error}` }
  } finally {
    await primaryPage.context.close()
    await secondPage?.context.close()
  }
  const failed = Object.entries(outcome.checks).filter(([, ok]) => !ok).map(([name]) => name)
  const evidence = {
    adversarial: true, runId: run.runId, target: run.kind, deployedBuild: run.deployedBuild,
    attackId: attack.id, mode: attack.mode, journey: attack.journey, tags: attack.tags ?? [], repeat,
    goal, secondGoal, fuzzSeed: attack.mode === "fuzz" ? ctx.seed : null,
    mutator: attack.mutator ?? null, mutatorApplied: mutator.applied, observed,
    serverErrors: counters.server, pageErrors: counters.page, outcome, error,
    fingerprint: outcome.verdict === "product_failure"
      ? fingerprint(attack.id, attack.journey, failed, outcome.unmet) : null,
    projects: readers.map(({ projectId, reader }) => ({ projectId, owner: reader.username })),
    jevRevision: JEV_REVISION,
    agents: agents.map((agent) => agent && { status: agent.status, elapsedMs: agent.elapsedMs,
      actions: agent.actions, modelCalls: agent.modelCalls }),
  }
  await testInfo.attach("smart-testing-evidence", { body: JSON.stringify(evidence), contentType: "application/json" })
  return outcome
}

/** A passing edit must also read back in a new browser without the writer's cache. */
async function confirmInFreshSession(
  browser: Browser, reader: PersistedSession, seeded: Parameters<typeof editorUrl>[0],
  contract: Contract, after: Snapshot, outcome: AdversarialOutcome,
): Promise<AdversarialOutcome> {
  const checked = contract.required.find((req) => req.kind === "target-value")
  if (outcome.verdict !== "passed" || checked?.kind !== "target-value") return outcome
  const stored = after.cells.find((cell) => cell.cellId === checked.cellId && cell.side === "target")?.value
  const fresh = await authenticatedPage(browser, reader, seeded)
  try {
    await fresh.page.goto(editorUrl(seeded))
    const surface = targetSurface(fresh.page, checked.cellId)
    await surface.waitFor({ state: "visible", timeout: 30_000 })
    const visible = (await surface.locator("[data-target-read-view] > [data-ph-mask], .ProseMirror").first().innerText()).trim()
    if (visible === stored) return { ...outcome, checks: { ...outcome.checks, freshSession: true } }
    return { ...outcome, verdict: "product_failure", checks: { ...outcome.checks, freshSession: false },
      reason: "Storage holds the edit, but a fresh session shows different text." }
  } finally {
    await fresh.context.close()
  }
}
