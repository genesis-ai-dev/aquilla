import { createHash } from "node:crypto"

/**
 * A stable identity for one kind of failure. The build sha is left out on
 * purpose: the same bug on two deploys must update one ticket, not open two.
 */
export function fingerprint(attackId: string, journey: string, failedChecks: string[], unmet: string[]): string {
  const key = [attackId, journey, [...failedChecks].sort().join(","), [...unmet].sort().join(",")].join("|")
  return createHash("sha256").update(key).digest("hex").slice(0, 12)
}

/** The line a ticket body carries so a later run can find it again. */
export const marker = (print: string) => `adv-fp:${print}`
