import { randomUUID } from "node:crypto"
import { test, expect } from "@playwright/test"
import { ATTACKS, titleFor } from "../attacks"
import { fingerprint } from "../fingerprint"
import type { AdversarialOutcome } from "../invariants"
import { PROBES, type ProbeResult } from "../probes"
import { runAttack } from "../run"
import { readRunContext } from "../state"

// One test per attack and repeat. Playwright's --repeat-each multiplies these;
// titles carry mode and id so the launcher can filter with --grep.
for (const attack of ATTACKS) {
  test(titleFor(attack, 0), async ({ browser }, testInfo) => {
    const outcome = await runAttack(browser, attack, testInfo.repeatEachIndex, testInfo)
    // Inconclusive is not a pass and not a product finding.
    test.skip(outcome.verdict === "inconclusive", outcome.reason)
    expect(outcome.verdict, outcome.reason).toBe("passed")
  })
}

// Red-team probes: scripted requests, no browser and no model (probes.ts).
for (const probe of PROBES) {
  test(titleFor({ id: probe.id, mode: "redteam" }, 0), async () => {
    const testInfo = test.info()
    const run = readRunContext()
    let result: Partial<ProbeResult> & { outcome: AdversarialOutcome }
    try {
      result = await probe.run(run, randomUUID().slice(0, 6))
    } catch (caught) {
      result = { outcome: { verdict: "inconclusive", checks: {}, diffs: [], unmet: [],
        reason: `The probe did not complete: ${caught instanceof Error ? caught.message : String(caught)}` } }
    }
    const { outcome } = result
    const failed = Object.entries(outcome.checks).filter(([, ok]) => !ok).map(([name]) => name)
    await testInfo.attach("smart-testing-evidence", { contentType: "application/json", body: JSON.stringify({
      adversarial: true, scripted: true, runId: run.runId, target: run.kind, deployedBuild: run.deployedBuild,
      attackId: probe.id, mode: "redteam", journey: probe.journey, tags: [], repeat: testInfo.repeatEachIndex,
      goal: result.goal ?? "", secondGoal: null, fuzzSeed: null, mutator: null,
      sent: result.sent ?? [], outcome, projects: result.projects ?? [],
      fingerprint: outcome.verdict === "product_failure" ? fingerprint(probe.id, probe.journey, failed, outcome.unmet) : null,
    }) })
    test.skip(outcome.verdict === "inconclusive", outcome.reason)
    expect(outcome.verdict, outcome.reason).toBe("passed")
  })
}
