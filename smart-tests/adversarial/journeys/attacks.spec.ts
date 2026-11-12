import { test, expect } from "@playwright/test"
import { ATTACKS, titleFor } from "../attacks"
import { runAttack } from "../run"

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
